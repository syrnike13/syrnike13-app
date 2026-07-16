#ifdef _WIN32
#include "livekit/windows_d3d11_h264_encoder.h"

#include <codecapi.h>
#include <d3d10.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <icodecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <objbase.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <limits>
#include <mutex>
#include <new>
#include <thread>
#include <unordered_map>
#include <vector>

#include "api/environment/environment.h"
#include "api/make_ref_counted.h"
#include "api/video/encoded_image.h"
#include "api/video_codecs/sdp_video_format.h"
#include "api/video_codecs/video_codec.h"
#include "api/video_codecs/video_encoder.h"
#include "media/base/codec.h"
#include "modules/video_coding/include/video_codec_interface.h"
#include "modules/video_coding/include/video_error_codes.h"

namespace livekit_ffi {
using Microsoft::WRL::ComPtr;

namespace {

constexpr uint64_t kScreenShareBitrateHeadroomPercent = 30;

UINT32 ScreenShareEncoderBitrate(uint64_t target_bitrate_bps,
                                 uint64_t max_bitrate_bps) {
  const uint64_t ceiling = max_bitrate_bps > 0
                               ? std::min<uint64_t>(
                                     max_bitrate_bps,
                                     std::numeric_limits<UINT32>::max())
                               : std::numeric_limits<UINT32>::max();
  const uint64_t target =
      std::clamp<uint64_t>(target_bitrate_bps, 1, ceiling);
  const uint64_t boosted =
      target + target * kScreenShareBitrateHeadroomPercent / 100;
  return static_cast<UINT32>(std::min(boosted, ceiling));
}

void TraceEncoder(const char* operation,
                  HRESULT result = S_OK,
                  long long detail = 0) {
  wchar_t log_path[32768]{};
  const DWORD path_length =
      GetEnvironmentVariableW(L"SYRNIKE_NATIVE_MEDIA_LOG_PATH", log_path,
                              static_cast<DWORD>(_countof(log_path)));
  if (path_length == 0 || path_length >= _countof(log_path))
    return;
  HANDLE output =
      CreateFileW(log_path, FILE_APPEND_DATA,
                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                  nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (output == INVALID_HANDLE_VALUE)
    return;
  char line[256]{};
  const int length =
      std::snprintf(line, _countof(line),
                    "{\"event\":\"mf_h264_trace\",\"operation\":\"%s\","
                    "\"hresult\":%lu,\"detail\":%lld}\n",
                    operation, static_cast<unsigned long>(result), detail);
  if (length > 0) {
    DWORD written = 0;
    const DWORD bytes_to_write = static_cast<DWORD>(
        std::min<int>(length, static_cast<int>(_countof(line) - 1)));
    WriteFile(output, line, bytes_to_write, &written, nullptr);
  }
  CloseHandle(output);
}

ComPtr<ID3D11Device1> CreateDeviceForLuid(uint64_t adapter_luid) {
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))))
    return nullptr;
  for (UINT index = 0;; ++index) {
    ComPtr<IDXGIAdapter1> adapter;
    if (factory->EnumAdapters1(index, &adapter) == DXGI_ERROR_NOT_FOUND)
      break;
    DXGI_ADAPTER_DESC1 description{};
    if (FAILED(adapter->GetDesc1(&description)))
      continue;
    const uint64_t candidate_luid =
        (static_cast<uint64_t>(
             static_cast<uint32_t>(description.AdapterLuid.HighPart))
         << 32) |
        description.AdapterLuid.LowPart;
    if (candidate_luid != adapter_luid)
      continue;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    D3D_FEATURE_LEVEL level{};
    if (FAILED(D3D11CreateDevice(
            adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT |
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            nullptr, 0, D3D11_SDK_VERSION, &device, &level, &context))) {
      return nullptr;
    }
    ComPtr<ID3D11Device1> device1;
    if (FAILED(device.As(&device1)))
      return nullptr;
    return device1;
  }
  return nullptr;
}

ComPtr<ID3D11Device1> GetLeaseReclaimDeviceForLuid(uint64_t adapter_luid) {
  static std::mutex cache_mutex;
  static std::unordered_map<uint64_t, ComPtr<ID3D11Device1>> devices;

  std::lock_guard lock(cache_mutex);
  const auto existing = devices.find(adapter_luid);
  if (existing != devices.end()) {
    ComPtr<ID3D11Device> device;
    if (SUCCEEDED(existing->second.As(&device)) &&
        SUCCEEDED(device->GetDeviceRemovedReason())) {
      return existing->second;
    }
    devices.erase(existing);
  }

  auto device = CreateDeviceForLuid(adapter_luid);
  if (device)
    devices.emplace(adapter_luid, device);
  return device;
}

bool SetCodecU32(IMFTransform* transform, const GUID& key, UINT32 value) {
  ComPtr<ICodecAPI> api;
  if (FAILED(transform->QueryInterface(IID_PPV_ARGS(&api))))
    return false;
  VARIANT setting{};
  setting.vt = VT_UI4;
  setting.ulVal = value;
  return SUCCEEDED(api->SetValue(&key, &setting));
}

bool EnumerateHardwareH264(IMFActivate*** activations, UINT32* count) {
  MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
  return SUCCEEDED(
             MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
                       MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                       nullptr, &output, activations, count)) &&
         *count > 0;
}

// The keyed mutex protects the capture pool slot only while the MFT can still
// read the input texture. Tying it to an output access unit is incorrect: a
// hardware encoder may retain, drop, or release an input sample without
// producing a one-to-one output. IMFTrackedSample reports the actual end of
// input ownership, so every slot is returned even when the driver drops input.
class TrackedInputLease final : public IMFAsyncCallback {
 public:
  TrackedInputLease(
      ComPtr<IDXGIKeyedMutex> keyed_mutex,
      uint64_t release_key,
      webrtc::scoped_refptr<D3D11TextureFrameBuffer> frame_buffer)
      : keyed_mutex_(std::move(keyed_mutex)),
        release_key_(release_key),
        frame_buffer_(std::move(frame_buffer)) {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (!object)
      return E_POINTER;
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IMFAsyncCallback)) {
      *object = static_cast<IMFAsyncCallback*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }

  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = --references_;
    if (remaining == 0)
      delete this;
    return remaining;
  }

  HRESULT STDMETHODCALLTYPE GetParameters(DWORD*, DWORD*) override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE Invoke(IMFAsyncResult*) override {
    Complete();
    return S_OK;
  }

  void Complete() noexcept {
    if (completed_.exchange(true))
      return;
    const HRESULT release_result =
        keyed_mutex_ ? keyed_mutex_->ReleaseSync(release_key_) : E_POINTER;
    if (FAILED(release_result)) {
      TraceEncoder("ReleaseTrackedInputLease", release_result);
      frame_buffer_->ReleaseLease(true);
    } else {
      frame_buffer_->ReleaseLease(false);
    }
    frame_buffer_ = nullptr;
    keyed_mutex_.Reset();
  }

 private:
  ~TrackedInputLease() { Complete(); }

  std::atomic<ULONG> references_{1};
  std::atomic_bool completed_{false};
  ComPtr<IDXGIKeyedMutex> keyed_mutex_;
  uint64_t release_key_ = 0;
  webrtc::scoped_refptr<D3D11TextureFrameBuffer> frame_buffer_;
};

class MfH264Encoder final : public webrtc::VideoEncoder {
  enum class SubmitResult { kSubmitted, kRetry, kFailed };

  struct InputJob {
    ComPtr<IMFSample> sample;
    LONGLONG sample_time = 0;
    uint32_t rtp_timestamp = 0;
    int64_t capture_time_ms = 0;
    int64_t ntp_time_ms = 0;
    webrtc::VideoRotation rotation = webrtc::kVideoRotation_0;
    bool keyframe = false;
    ComPtr<TrackedInputLease> lease;
  };
  struct PendingOutput {
    uint32_t rtp_timestamp = 0;
    int64_t capture_time_ms = 0;
    int64_t ntp_time_ms = 0;
    webrtc::VideoRotation rotation = webrtc::kVideoRotation_0;
    ComPtr<TrackedInputLease> lease;
  };

 public:
  ~MfH264Encoder() override { Release(); }

  int InitEncode(const webrtc::VideoCodec* codec, const Settings&) override {
    if (!codec || codec->codecType != webrtc::kVideoCodecH264 ||
        codec->width == 0 || codec->height == 0) {
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    }
    Release();
    std::lock_guard lock(mutex_);
    width_ = codec->width;
    height_ = codec->height;
    fps_ = std::max<UINT32>(1, codec->maxFramerate);
    max_bitrate_bps_ = codec->maxBitrate > 0
                           ? static_cast<uint64_t>(codec->maxBitrate) * 1000
                           : std::numeric_limits<UINT32>::max();
    bitrate_bps_ = ScreenShareEncoderBitrate(
        static_cast<uint64_t>(codec->startBitrate) * 1000,
        max_bitrate_bps_);
    if (!IsWindowsD3D11HardwareH264Supported())
      return WEBRTC_VIDEO_CODEC_ERROR;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t RegisterEncodeCompleteCallback(
      webrtc::EncodedImageCallback* callback) override {
    std::lock_guard lock(mutex_);
    callback_ = callback;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t Release() override {
    const HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninitialize_com = SUCCEEDED(com_result);
    std::thread worker;
    ComPtr<IMFShutdown> shutdown;
    {
      std::lock_guard lock(mutex_);
      stopping_ = true;
      cv_.notify_all();
      worker = std::move(worker_);
      shutdown = shutdown_;
    }
    // Hardware MFTs can remain blocked inside ProcessOutput after a GPU
    // workload transition. Joining first would then pin the whole native
    // runtime forever. IMFShutdown is explicitly callable from the owning
    // process to cancel outstanding asynchronous MFT work, so request it
    // before waiting for the encoder worker to leave.
    if (shutdown) {
      const HRESULT shutdown_result = shutdown->Shutdown();
      TraceEncoder("ShutdownBeforeRelease", shutdown_result);
    }
    if (worker.joinable())
      worker.join();
    std::lock_guard lock(mutex_);
    ReleaseMftLocked();
    stopping_ = false;
    failed_ = false;
    if (uninitialize_com)
      CoUninitialize();
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t Encode(
      const webrtc::VideoFrame& frame,
      const std::vector<webrtc::VideoFrameType>* frame_types) override {
    auto* native = dynamic_cast<D3D11TextureFrameBuffer*>(
        frame.video_frame_buffer().get());
    std::unique_lock lock(mutex_);
    if (!callback_)
      return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    if (!native || native->width() != width_ || native->height() != height_)
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    if (failed_ || stopping_)
      return WEBRTC_VIDEO_CODEC_ERROR;
    if (!encoder_) {
      if (!InitializeLocked(native->adapter_luid())) {
        ReleaseMftLocked();
        return WEBRTC_VIDEO_CODEC_ERROR;
      }
      try {
        worker_ = std::thread(&MfH264Encoder::WorkerMain, this);
      } catch (...) {
        ReleaseMftLocked();
        failed_ = true;
        return WEBRTC_VIDEO_CODEC_ERROR;
      }
    }
    if (input_jobs_.size() >= kMaxQueuedInputs) {
      return WEBRTC_VIDEO_CODEC_NO_OUTPUT;
    }
    const bool keyframe =
        frame_types &&
        std::find(frame_types->begin(), frame_types->end(),
                  webrtc::VideoFrameType::kVideoFrameKey) != frame_types->end();

    ComPtr<ID3D11Texture2D> texture;
    ComPtr<IDXGIKeyedMutex> keyed_mutex;
    HRESULT hr = device1_->OpenSharedResource1(native->shared_handle(),
                                               IID_PPV_ARGS(&texture));
    if (SUCCEEDED(hr))
      hr = texture.As(&keyed_mutex);
    if (SUCCEEDED(hr))
      hr = keyed_mutex->AcquireSync(native->acquire_key(), 1000);
    if (FAILED(hr)) {
      TraceEncoder("AcquireInputLease", hr, frame.rtp_timestamp());
      // The capture pool still owns this unencoded slot, so advance its keyed
      // mutex before reporting the failure and allowing the slot to be reused.
      native->ReleaseLease(true);
      return WEBRTC_VIDEO_CODEC_ERROR;
    }

    ComPtr<IMFMediaBuffer> surface;
    hr = MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), texture.Get(), 0,
                                   FALSE, &surface);
    ComPtr<IMFTrackedSample> tracked_sample;
    ComPtr<IMFSample> sample;
    if (SUCCEEDED(hr))
      hr = MFCreateTrackedSample(&tracked_sample);
    if (SUCCEEDED(hr))
      hr = tracked_sample.As(&sample);
    if (SUCCEEDED(hr))
      hr = sample->AddBuffer(surface.Get());
    const LONGLONG sample_time =
        static_cast<LONGLONG>(frame.rtp_timestamp()) * 10'000'000 / 90'000;
    if (SUCCEEDED(hr))
      hr = sample->SetSampleTime(sample_time);
    if (SUCCEEDED(hr))
      hr = sample->SetSampleDuration(10'000'000 / fps_);
    ComPtr<TrackedInputLease> lease;
    if (SUCCEEDED(hr)) {
      lease.Attach(new (std::nothrow) TrackedInputLease(
          keyed_mutex, native->release_key(),
          webrtc::scoped_refptr<D3D11TextureFrameBuffer>(native)));
      if (!lease) {
        hr = E_OUTOFMEMORY;
      } else {
        hr = tracked_sample->SetAllocator(lease.Get(), nullptr);
      }
    }
    if (FAILED(hr)) {
      if (lease) {
        lease->Complete();
      } else {
        const HRESULT release_result =
            keyed_mutex->ReleaseSync(native->release_key());
        if (FAILED(release_result)) {
          TraceEncoder("ReleaseInputLease", release_result);
          native->ReleaseLease(true);
        } else {
          native->ReleaseLease(false);
        }
      }
      return WEBRTC_VIDEO_CODEC_ERROR;
    }
    input_jobs_.push_back(InputJob{
        sample, sample_time, frame.rtp_timestamp(), frame.render_time_ms(),
        frame.ntp_time_ms(), frame.rotation(), keyframe,
        std::move(lease)});
    cv_.notify_one();
    return WEBRTC_VIDEO_CODEC_OK;
  }

  void SetRates(const RateControlParameters& parameters) override {
    std::lock_guard lock(mutex_);
    const UINT32 bitrate = ScreenShareEncoderBitrate(
        parameters.bitrate.get_sum_bps(), max_bitrate_bps_);
    const UINT32 fps =
        static_cast<UINT32>(std::max(1.0, parameters.framerate_fps));
    if (bitrate != bitrate_bps_) {
      bitrate_bps_ = bitrate;
      rates_dirty_ = encoder_ != nullptr;
    }
    fps_ = fps;
    cv_.notify_one();
  }

  EncoderInfo GetEncoderInfo() const override {
    EncoderInfo info;
    info.supports_native_handle = true;
    info.is_hardware_accelerated = true;
    // The MFT is configured for CBR and this adapter bounds its input queue.
    // Let it own frame dropping; WebRTC's generic dropper cannot observe the
    // asynchronous MFT queue and can otherwise suppress native frames after a
    // large initial keyframe.
    info.has_trusted_rate_controller = true;
    info.requested_resolution_alignment = 2;
    info.implementation_name = "Windows Media Foundation D3D11 H.264";
    info.scaling_settings = ScalingSettings::kOff;
    return info;
  }

 private:
  bool InitializeLocked(uint64_t adapter_luid) {
    if (FAILED(MFStartup(MF_VERSION)))
      return false;
    mf_started_ = true;
    UINT flags =
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    device1_ = CreateDeviceForLuid(adapter_luid);
    if (!device1_ || FAILED(device1_.As(&device_)))
      return false;
    ComPtr<ID3D10Multithread> multithread;
    if (FAILED(device_.As(&multithread)))
      return false;
    multithread->SetMultithreadProtected(TRUE);
    device_->SetExceptionMode(0);

    IMFActivate** raw = nullptr;
    UINT32 count = 0;
    if (!EnumerateHardwareH264(&raw, &count))
      return false;
    for (UINT32 i = 0; i < count; ++i) {
      ComPtr<IMFTransform> candidate;
      if (FAILED(raw[i]->ActivateObject(IID_PPV_ARGS(&candidate))))
        continue;
      ComPtr<IMFAttributes> attributes;
      UINT32 candidate_async = FALSE;
      bool usable = SUCCEEDED(candidate->GetAttributes(&attributes));
      if (usable) {
        attributes->GetUINT32(MF_TRANSFORM_ASYNC, &candidate_async);
        usable = SUCCEEDED(attributes->SetUINT32(MF_LOW_LATENCY, TRUE));
      }
      ComPtr<IMFMediaEventGenerator> events;
      ComPtr<IMFShutdown> shutdown;
      if (usable && candidate_async) {
        usable =
            SUCCEEDED(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE)) &&
            SUCCEEDED(candidate.As(&events)) &&
            SUCCEEDED(candidate.As(&shutdown));
      }
      if (!usable) {
        raw[i]->ShutdownObject();
        continue;
      }
      activation_ = raw[i];
      encoder_ = std::move(candidate);
      event_generator_ = std::move(events);
      shutdown_ = std::move(shutdown);
      asynchronous_ = candidate_async;
      break;
    }
    for (UINT32 i = 0; i < count; ++i)
      raw[i]->Release();
    CoTaskMemFree(raw);
    if (!encoder_ || !activation_)
      return false;
    UINT token = 0;
    if (FAILED(MFCreateDXGIDeviceManager(&token, &manager_)) ||
        FAILED(manager_->ResetDevice(device_.Get(), token)) ||
        FAILED(encoder_->ProcessMessage(
            MFT_MESSAGE_SET_D3D_MANAGER,
            reinterpret_cast<ULONG_PTR>(manager_.Get())))) {
      return false;
    }
    ComPtr<IMFMediaType> output;
    if (FAILED(MFCreateMediaType(&output)) ||
        FAILED(output->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
        FAILED(output->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264)) ||
        FAILED(MFSetAttributeSize(output.Get(), MF_MT_FRAME_SIZE, width_,
                                  height_)) ||
        FAILED(MFSetAttributeRatio(output.Get(), MF_MT_FRAME_RATE, fps_, 1)) ||
        FAILED(MFSetAttributeRatio(output.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1,
                                   1)) ||
        FAILED(output->SetUINT32(MF_MT_AVG_BITRATE, bitrate_bps_)) ||
        FAILED(output->SetUINT32(MF_MT_INTERLACE_MODE,
                                 MFVideoInterlace_Progressive)) ||
        FAILED(output->SetUINT32(MF_MT_MPEG2_PROFILE,
                                 eAVEncH264VProfile_ConstrainedBase)) ||
        FAILED(
            output->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709)) ||
        FAILED(
            output->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709)) ||
        FAILED(
            output->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709)) ||
        FAILED(output->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE,
                                 MFNominalRange_16_235)) ||
        FAILED(encoder_->SetOutputType(0, output.Get(), 0)))
      return false;
    ComPtr<IMFMediaType> input;
    if (FAILED(MFCreateMediaType(&input)) ||
        FAILED(input->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
        FAILED(input->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12)) ||
        FAILED(MFSetAttributeSize(input.Get(), MF_MT_FRAME_SIZE, width_,
                                  height_)) ||
        FAILED(MFSetAttributeRatio(input.Get(), MF_MT_FRAME_RATE, fps_, 1)) ||
        FAILED(input->SetUINT32(MF_MT_INTERLACE_MODE,
                                MFVideoInterlace_Progressive)) ||
        FAILED(
            input->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709)) ||
        FAILED(
            input->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709)) ||
        FAILED(
            input->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709)) ||
        FAILED(input->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE,
                                MFNominalRange_16_235)) ||
        FAILED(encoder_->SetInputType(0, input.Get(), 0)) ||
        !SetCodecU32(encoder_.Get(), CODECAPI_AVLowLatencyMode, TRUE) ||
        !SetCodecU32(encoder_.Get(), CODECAPI_AVEncCommonRateControlMode,
                     eAVEncCommonRateControlMode_CBR) ||
        !SetCodecU32(encoder_.Get(), CODECAPI_AVEncCommonMeanBitRate,
                     bitrate_bps_))
      return false;
    SetCodecU32(encoder_.Get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0);
    if (FAILED(encoder_->GetOutputStreamInfo(0, &output_info_)) ||
        FAILED(encoder_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)) ||
        FAILED(
            encoder_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)) ||
        FAILED(encoder_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)))
      return false;
    rates_dirty_ = false;
    return true;
  }

  HRESULT ReconfigureOutputAfterStreamChange() {
    for (DWORD index = 0;; ++index) {
      ComPtr<IMFMediaType> type;
      const HRESULT available =
          encoder_->GetOutputAvailableType(0, index, &type);
      if (available == MF_E_NO_MORE_TYPES)
        break;
      if (FAILED(available))
        return available;

      GUID major = GUID_NULL;
      GUID subtype = GUID_NULL;
      if (FAILED(type->GetGUID(MF_MT_MAJOR_TYPE, &major)) ||
          FAILED(type->GetGUID(MF_MT_SUBTYPE, &subtype)) ||
          major != MFMediaType_Video || subtype != MFVideoFormat_H264) {
        continue;
      }
      UINT32 width = 0;
      UINT32 height = 0;
      const HRESULT size_result =
          MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &width, &height);
      if (SUCCEEDED(size_result) && (width != width_ || height != height_)) {
        continue;
      }
      const HRESULT set_result = encoder_->SetOutputType(0, type.Get(), 0);
      if (FAILED(set_result))
        continue;
      const HRESULT info_result =
          encoder_->GetOutputStreamInfo(0, &output_info_);
      if (SUCCEEDED(info_result)) {
        TraceEncoder("OutputStreamChanged", S_OK);
      }
      return info_result;
    }
    return MF_E_INVALIDMEDIATYPE;
  }

  HRESULT PullOutputOnce() {
    ComPtr<IMFSample> sample;
    if (!(output_info_.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
      ComPtr<IMFMediaBuffer> buffer;
      if (FAILED(MFCreateSample(&sample)) ||
          FAILED(MFCreateMemoryBuffer(
              std::max<DWORD>(output_info_.cbSize, 2 * 1024 * 1024),
              &buffer)) ||
          FAILED(sample->AddBuffer(buffer.Get()))) {
        return E_FAIL;
      }
    }
    MFT_OUTPUT_DATA_BUFFER output{};
    output.dwStreamID = 0;
    output.pSample = sample.Get();
    DWORD status = 0;
    const HRESULT hr = encoder_->ProcessOutput(0, 1, &output, &status);
    if (FAILED(hr) && hr != MF_E_TRANSFORM_STREAM_CHANGE &&
        hr != MF_E_TRANSFORM_NEED_MORE_INPUT) {
      TraceEncoder("ProcessOutput", hr);
    }
    if (SUCCEEDED(hr)) {
      IMFSample* actual = output.pSample ? output.pSample : sample.Get();
      ComPtr<IMFMediaBuffer> contiguous;
      if (!actual || FAILED(actual->ConvertToContiguousBuffer(&contiguous))) {
        TraceEncoder("ConvertToContiguousBuffer", E_FAIL);
        ReleaseOutputBuffer(output, sample.Get());
        return E_FAIL;
      }
      // Low-latency mode with B-frames disabled preserves submission order, but
      // hardware MFTs are allowed to omit or normalize the output sample time.
      // Match the access unit to the oldest accepted input instead of relying
      // on an exact timestamp round-trip through the driver.
      if (pending_outputs_.empty()) {
        TraceEncoder("MissingPendingOutput", E_FAIL);
        ReleaseOutputBuffer(output, sample.Get());
        return E_FAIL;
      }
      const uint32_t rtp_timestamp = pending_outputs_.front().rtp_timestamp;
      BYTE* bytes = nullptr;
      DWORD length = 0;
      if (FAILED(contiguous->Lock(&bytes, nullptr, &length))) {
        TraceEncoder("LockOutput", E_FAIL);
        ReleaseOutputBuffer(output, sample.Get());
        return E_FAIL;
      }
      if (length == 0) {
        TraceEncoder("EmptyOutput", E_FAIL);
        contiguous->Unlock();
        ReleaseOutputBuffer(output, sample.Get());
        return E_FAIL;
      }
      webrtc::EncodedImage image;
      image.SetEncodedData(webrtc::EncodedImageBuffer::Create(bytes, length));
      contiguous->Unlock();
      image.SetRtpTimestamp(rtp_timestamp);
      image.SetSimulcastIndex(0);
      image.capture_time_ms_ = pending_outputs_.front().capture_time_ms;
      image.ntp_time_ms_ = pending_outputs_.front().ntp_time_ms;
      image.rotation_ = pending_outputs_.front().rotation;
      image.content_type_ = webrtc::VideoContentType::SCREENSHARE;
      image.timing_.flags = webrtc::VideoSendTiming::kInvalid;
      image._encodedWidth = width_;
      image._encodedHeight = height_;
      UINT32 clean = FALSE;
      actual->GetUINT32(MFSampleExtension_CleanPoint, &clean);
      image.SetFrameType(clean ? webrtc::VideoFrameType::kVideoFrameKey
                               : webrtc::VideoFrameType::kVideoFrameDelta);
      webrtc::CodecSpecificInfo codec_info;
      codec_info.codecType = webrtc::kVideoCodecH264;
      codec_info.codecSpecific.H264.packetization_mode =
          webrtc::H264PacketizationMode::NonInterleaved;
      codec_info.codecSpecific.H264.temporal_idx = webrtc::kNoTemporalIdx;
      codec_info.codecSpecific.H264.base_layer_sync = false;
      codec_info.codecSpecific.H264.idr_frame = clean != FALSE;
      PendingOutput completed = std::move(pending_outputs_.front());
      pending_outputs_.pop_front();
      webrtc::EncodedImageCallback* callback = nullptr;
      {
        std::lock_guard lock(mutex_);
        callback = callback_;
      }
      if (!callback) {
        TraceEncoder("OnEncodedImage", E_FAIL);
        ReleaseOutputBuffer(output, sample.Get());
        return E_FAIL;
      }
      const auto callback_result = callback->OnEncodedImage(image, &codec_info);
      if (callback_result.error != webrtc::EncodedImageCallback::Result::OK) {
        TraceEncoder("OnEncodedImage", E_FAIL,
                     callback_result.drop_next_frame ? 1 : 0);
        ReleaseOutputBuffer(output, sample.Get());
        return E_FAIL;
      }
    }
    ReleaseOutputBuffer(output, sample.Get());
    return hr;
  }

  HRESULT PullOutput() {
    HRESULT hr = PullOutputOnce();
    if (hr != MF_E_TRANSFORM_STREAM_CHANGE)
      return hr;

    hr = ReconfigureOutputAfterStreamChange();
    if (FAILED(hr)) {
      TraceEncoder("ReconfigureOutput", hr);
      return hr;
    }
    // The stream-change result did not consume the pending access unit. Retry
    // once with a buffer sized from the transform's new stream information.
    hr = PullOutputOnce();
    if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
      TraceEncoder("RepeatedOutputStreamChange", hr);
    }
    return hr;
  }

  static void ReleaseOutputBuffer(MFT_OUTPUT_DATA_BUFFER& output,
                                  IMFSample* supplied) {
    if (output.pEvents)
      output.pEvents->Release();
    if (output.pSample && output.pSample != supplied)
      output.pSample->Release();
  }

  SubmitResult Submit(InputJob&& job) {
    if (job.keyframe &&
        !SetCodecU32(encoder_.Get(), CODECAPI_AVEncVideoForceKeyFrame, TRUE))
      return SubmitResult::kFailed;
    const HRESULT hr = encoder_->ProcessInput(0, job.sample.Get(), 0);
    if (hr == MF_E_NOTACCEPTING) {
      TraceEncoder("ProcessInputNotAccepting", hr, job.sample_time);
      return SubmitResult::kRetry;
    }
    if (FAILED(hr)) {
      TraceEncoder("ProcessInput", hr, job.sample_time);
      return SubmitResult::kFailed;
    }
    PendingOutput pending{job.rtp_timestamp, job.capture_time_ms,
                          job.ntp_time_ms, job.rotation, std::move(job.lease)};
    pending_outputs_.push_back(std::move(pending));
    return SubmitResult::kSubmitted;
  }

  bool PumpAsyncEvent(size_t* need_input_count,
                      bool* drain_complete,
                      bool* produced_output = nullptr) {
    ComPtr<IMFMediaEvent> event;
    const HRESULT hr =
        event_generator_->GetEvent(MF_EVENT_FLAG_NO_WAIT, &event);
    if (hr == MF_E_NO_EVENTS_AVAILABLE)
      return true;
    if (FAILED(hr)) {
      TraceEncoder("GetEvent", hr);
      return false;
    }
    HRESULT event_status = S_OK;
    MediaEventType type = MEUnknown;
    const HRESULT status_result = event->GetStatus(&event_status);
    const HRESULT type_result = event->GetType(&type);
    if (FAILED(status_result) || FAILED(event_status) || FAILED(type_result)) {
      TraceEncoder("EventStatus",
                   FAILED(status_result)  ? status_result
                   : FAILED(event_status) ? event_status
                                          : type_result,
                   static_cast<long long>(type));
      return false;
    }
    if (type == METransformNeedInput)
      ++(*need_input_count);
    else if (type == METransformHaveOutput) {
      if (FAILED(PullOutput()))
        return false;
      if (produced_output)
        *produced_output = true;
    } else if (type == METransformDrainComplete) {
      *drain_complete = true;
    }
    return true;
  }

  void WorkerMain() {
    const HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninitialize_com = SUCCEEDED(com_result);
    if (FAILED(com_result) && com_result != RPC_E_CHANGED_MODE) {
      FailWorker("CoInitializeEx");
      ReleaseAllLeases();
      return;
    }
    size_t need_input_count = asynchronous_ ? 0 : 1;
    bool input_blocked_until_output = false;
    size_t not_accepting_retries = 0;
    std::chrono::steady_clock::time_point not_accepting_deadline{};
    bool drain_complete = false;
    for (;;) {
      bool stopping = false;
      bool rates_dirty = false;
      UINT32 bitrate = 0;
      {
        std::lock_guard lock(mutex_);
        stopping = stopping_;
        rates_dirty = rates_dirty_;
        bitrate = bitrate_bps_;
        rates_dirty_ = false;
      }
      if (stopping)
        break;
      // Some hardware MFTs reject a redundant or mid-stream bitrate update.
      // The stream remains valid at its last applied bitrate, so a rate-control
      // rejection must not terminate encoding after the first frame.
      if (rates_dirty) {
        SetCodecU32(encoder_.Get(), CODECAPI_AVEncCommonMeanBitRate, bitrate);
      }
      if (asynchronous_) {
        bool produced_output = false;
        if (!PumpAsyncEvent(&need_input_count, &drain_complete,
                            &produced_output)) {
          FailWorker("PumpAsyncEvent");
          break;
        }
        if (produced_output) {
          input_blocked_until_output = false;
          not_accepting_retries = 0;
        } else if (input_blocked_until_output &&
                   std::chrono::steady_clock::now() >= not_accepting_deadline) {
          // A buggy driver can lose HaveOutput after MF_E_NOTACCEPTING. Permit
          // a bounded retry with the preserved token; repeated rejection
          // fails the encoder explicitly so its owner can restart it instead
          // of leaving the input queue parked forever.
          input_blocked_until_output = false;
          TraceEncoder("ProcessInputRetryWatchdog", MF_E_NOTACCEPTING,
                       static_cast<long long>(not_accepting_retries));
        }
      }
      InputJob job;
      bool have_job = false;
      if (need_input_count > 0 && !input_blocked_until_output) {
        std::lock_guard lock(mutex_);
        if (!input_jobs_.empty()) {
          job = std::move(input_jobs_.front());
          input_jobs_.pop_front();
          have_job = true;
        }
      }
      if (have_job) {
        const SubmitResult submit_result = Submit(std::move(job));
        if (submit_result == SubmitResult::kRetry) {
          {
            std::lock_guard lock(mutex_);
            input_jobs_.push_front(std::move(job));
          }
          // MF_E_NOTACCEPTING does not consume the NeedInput token. Preserve
          // it, but wait until output makes progress before retrying this frame
          // so the worker cannot spin on ProcessInput.
          input_blocked_until_output = asynchronous_;
          if (asynchronous_) {
            not_accepting_deadline =
                std::chrono::steady_clock::now() + kNotAcceptingRetryDelay;
            if (++not_accepting_retries >= kMaxNotAcceptingRetries) {
              FailWorker("ProcessInputNotAcceptingTimeout");
              break;
            }
          }
        } else if (submit_result == SubmitResult::kFailed) {
          if (job.lease)
            job.lease->Complete();
          FailWorker("Submit");
          break;
        } else if (asynchronous_) {
          --need_input_count;
        }
      }
      if (!asynchronous_) {
        HRESULT hr = S_OK;
        while ((hr = PullOutput()) == S_OK) {
        }
        if (hr != MF_E_TRANSFORM_NEED_MORE_INPUT) {
          FailWorker("PullOutput");
          break;
        }
      }
      std::unique_lock lock(mutex_);
      const bool can_submit =
          need_input_count > 0 && !input_blocked_until_output;
      cv_.wait_for(lock, std::chrono::milliseconds(2), [this, can_submit] {
        return stopping_ || rates_dirty_ ||
               (can_submit && !input_jobs_.empty());
      });
    }
    DrainAndStop();
    if (uninitialize_com)
      CoUninitialize();
  }

  void FailWorker(const char* operation) {
    TraceEncoder(operation, E_FAIL);
    std::lock_guard lock(mutex_);
    failed_ = true;
  }

  void DrainAndStop() {
    if (encoder_) {
      encoder_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
      encoder_->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
      const auto deadline =
          std::chrono::steady_clock::now() + std::chrono::seconds(2);
      size_t need_input_count = 0;
      bool drain_complete = false;
      if (asynchronous_) {
        while (!drain_complete && std::chrono::steady_clock::now() < deadline) {
          if (!PumpAsyncEvent(&need_input_count, &drain_complete))
            break;
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
      } else {
        while (std::chrono::steady_clock::now() < deadline &&
               PullOutput() == S_OK) {
        }
      }
      encoder_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
      encoder_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    }
    // Drain/flush does not guarantee that every hardware MFT has released its
    // D3D11 input surfaces. Stop the transform before force-releasing leases,
    // otherwise the capture pool may overwrite a texture still owned by the
    // GPU driver during an encoder failure.
    if (shutdown_)
      shutdown_->Shutdown();
    ReleaseAllLeases();
  }

  void ReleaseAllLeases() {
    std::deque<InputJob> abandoned;
    {
      std::lock_guard lock(mutex_);
      abandoned.swap(input_jobs_);
    }
    for (auto& job : abandoned)
      if (job.lease)
        job.lease->Complete();
    for (auto& entry : pending_outputs_)
      if (entry.lease)
        entry.lease->Complete();
    pending_outputs_.clear();
  }

  void ReleaseMftLocked() {
    if (shutdown_)
      shutdown_->Shutdown();
    if (activation_)
      activation_->ShutdownObject();
    shutdown_.Reset();
    event_generator_.Reset();
    activation_.Reset();
    encoder_.Reset();
    manager_.Reset();
    device1_.Reset();
    device_.Reset();
    if (mf_started_)
      MFShutdown();
    mf_started_ = false;
    asynchronous_ = FALSE;
  }

  static constexpr size_t kMaxQueuedInputs = 6;
  static constexpr size_t kMaxNotAcceptingRetries = 4;
  static constexpr auto kNotAcceptingRetryDelay =
      std::chrono::milliseconds(500);
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::thread worker_;
  webrtc::EncodedImageCallback* callback_ = nullptr;
  UINT32 width_ = 0, height_ = 0, fps_ = 30, bitrate_bps_ = 2'000'000;
  uint64_t max_bitrate_bps_ = std::numeric_limits<UINT32>::max();
  bool mf_started_ = false;
  MFT_OUTPUT_STREAM_INFO output_info_{};
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11Device1> device1_;
  ComPtr<IMFDXGIDeviceManager> manager_;
  ComPtr<IMFActivate> activation_;
  ComPtr<IMFTransform> encoder_;
  ComPtr<IMFMediaEventGenerator> event_generator_;
  ComPtr<IMFShutdown> shutdown_;
  UINT32 asynchronous_ = FALSE;
  bool stopping_ = false;
  bool failed_ = false;
  bool rates_dirty_ = false;
  std::deque<InputJob> input_jobs_;
  std::deque<PendingOutput> pending_outputs_;
};

class MfH264EncoderFactory final : public webrtc::VideoEncoderFactory {
 public:
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return {webrtc::SdpVideoFormat("H264", {{"profile-level-id", "42e01f"},
                                            {"level-asymmetry-allowed", "1"},
                                            {"packetization-mode", "1"}})};
  }
  CodecSupport QueryCodecSupport(const webrtc::SdpVideoFormat& format,
                                 std::optional<std::string>) const override {
    return {.is_supported =
                format.name == "H264" && IsWindowsD3D11HardwareH264Supported(),
            .is_power_efficient = true};
  }
  std::unique_ptr<webrtc::VideoEncoder> Create(
      const webrtc::Environment&,
      const webrtc::SdpVideoFormat& format) override {
    if (format.name != "H264" || !IsWindowsD3D11HardwareH264Supported())
      return nullptr;
    return std::make_unique<MfH264Encoder>();
  }
};

}  // namespace

D3D11TextureFrameBuffer::D3D11TextureFrameBuffer(
    HANDLE shared_handle,
    std::uint64_t adapter_luid,
    std::uint64_t acquire_key,
    std::uint64_t release_key,
    int width,
    int height,
    std::function<void()> release_callback)
    : shared_handle_(nullptr),
      adapter_luid_(adapter_luid),
      acquire_key_(acquire_key),
      release_key_(release_key),
      width_(width),
      height_(height),
      release_callback_(std::move(release_callback)) {
  DuplicateHandle(GetCurrentProcess(), shared_handle, GetCurrentProcess(),
                  &shared_handle_, 0, FALSE, DUPLICATE_SAME_ACCESS);
}
D3D11TextureFrameBuffer::~D3D11TextureFrameBuffer() {
  ReleaseLease();
  if (shared_handle_) {
    CloseHandle(shared_handle_);
    shared_handle_ = nullptr;
  }
}

webrtc::scoped_refptr<webrtc::VideoFrameBuffer>
D3D11TextureFrameBuffer::CropAndScale(int, int, int, int, int, int) {
  // Screen capture already caps the D3D11 texture at the requested preset.
  // Keep WebRTC adaptation on frame rate and bitrate: its default native
  // CropAndScale path calls ToI420(), which is intentionally unavailable and
  // would also break the zero-copy hardware encode path. Returning a ref to
  // this buffer preserves both the native texture and its original geometry.
  return webrtc::scoped_refptr<webrtc::VideoFrameBuffer>(this);
}

void D3D11TextureFrameBuffer::ReleaseLease(bool reclaim_unencoded) {
  std::function<void()> release_callback;
  {
    std::lock_guard lock(lease_mutex_);
    if (released_)
      return;

    // A frame can be dropped by WebRTC before Encode. Only mark it released
    // after the keyed mutex has actually been advanced; a concurrent encoder
    // release can then retry if this bounded reclaim loses the race.
    if (reclaim_unencoded) {
      if (!shared_handle_)
        return;
      const auto deadline =
          std::chrono::steady_clock::now() + std::chrono::milliseconds(50);
      bool reclaimed = false;
      HRESULT reclaim_result = E_FAIL;
      do {
        auto device = GetLeaseReclaimDeviceForLuid(adapter_luid_);
        ComPtr<ID3D11Texture2D> texture;
        ComPtr<IDXGIKeyedMutex> keyed_mutex;
        if (device) {
          reclaim_result = device->OpenSharedResource1(shared_handle_,
                                                       IID_PPV_ARGS(&texture));
          if (SUCCEEDED(reclaim_result)) {
            reclaim_result = texture.As(&keyed_mutex);
          }
          if (SUCCEEDED(reclaim_result)) {
            reclaim_result = keyed_mutex->AcquireSync(acquire_key_, 5);
          }
          if (reclaim_result == S_OK) {
            reclaim_result = keyed_mutex->ReleaseSync(release_key_);
            reclaimed = SUCCEEDED(reclaim_result);
          }
        }
        if (!reclaimed)
          SwitchToThread();
      } while (!reclaimed && std::chrono::steady_clock::now() < deadline);
      if (!reclaimed) {
        TraceEncoder("LeaseReclaimDeferred", reclaim_result);
        return;
      }
    }
    released_ = true;
    release_callback = std::move(release_callback_);
  }
  if (release_callback)
    release_callback();
}

bool IsWindowsD3D11HardwareH264Supported() {
  static const bool supported = [] {
    const HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninitialize_com = SUCCEEDED(com_result);
    if (FAILED(com_result) && com_result != RPC_E_CHANGED_MODE)
      return false;
    if (FAILED(MFStartup(MF_VERSION))) {
      if (uninitialize_com)
        CoUninitialize();
      return false;
    }
    IMFActivate** activations = nullptr;
    UINT32 count = 0;
    const bool enumerated = EnumerateHardwareH264(&activations, &count);
    bool found = false;
    if (enumerated) {
      for (UINT32 i = 0; i < count; ++i) {
        ComPtr<IMFTransform> transform;
        if (FAILED(activations[i]->ActivateObject(IID_PPV_ARGS(&transform))))
          continue;
        ComPtr<IMFAttributes> attributes;
        UINT32 async = FALSE;
        if (SUCCEEDED(transform->GetAttributes(&attributes))) {
          attributes->GetUINT32(MF_TRANSFORM_ASYNC, &async);
        }
        bool usable = true;
        if (async) {
          ComPtr<IMFMediaEventGenerator> events;
          ComPtr<IMFShutdown> shutdown;
          usable = attributes &&
                   SUCCEEDED(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK,
                                                   TRUE)) &&
                   SUCCEEDED(transform.As(&events)) &&
                   SUCCEEDED(transform.As(&shutdown));
        }
        activations[i]->ShutdownObject();
        if (usable) {
          found = true;
          break;
        }
      }
    }
    for (UINT32 i = 0; i < count; ++i)
      activations[i]->Release();
    CoTaskMemFree(activations);
    MFShutdown();
    if (uninitialize_com)
      CoUninitialize();
    return found;
  }();
  return supported;
}

std::unique_ptr<webrtc::VideoEncoderFactory>
CreateWindowsD3D11HardwareH264EncoderFactory() {
  if (!IsWindowsD3D11HardwareH264Supported())
    return nullptr;
  return std::make_unique<MfH264EncoderFactory>();
}

}  // namespace livekit_ffi
#endif
