#include <codecapi.h>
#include <d3d11.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <icodecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

#include "media/screen_gpu_capture.hpp"
#include "media/screen_video_capture_benchmark.hpp"

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;

namespace {
void check(HRESULT hr, const char *operation) {
  if (FAILED(hr))
    throw std::runtime_error(std::string(operation) + " failed (HRESULT " +
                             std::to_string(hr) + ")");
}

uint64_t checksum(const uint8_t *data, size_t size) {
  uint64_t hash = 1469598103934665603ull;
  for (size_t i = 0; i < size; i += 97)
    hash = (hash ^ data[i]) * 1099511628211ull;
  return hash;
}

struct Result {
  std::string name;
  double milliseconds;
  size_t iterations;
  uint64_t cpu_bytes;
  uint64_t sum;
};
void print_result(const Result &r) {
  const double per_frame = r.milliseconds / static_cast<double>(r.iterations);
  std::cout << "RESULT path=" << r.name << " frames=" << r.iterations
            << " total_ms=" << std::fixed << std::setprecision(3)
            << r.milliseconds << " avg_ms=" << per_frame
            << " fps=" << (1000.0 / per_frame)
            << " cpu_copy_bytes_per_frame=" << (r.cpu_bytes / r.iterations)
            << " checksum=" << r.sum << '\n';
}

void scale_bgra(const uint8_t *src, uint32_t sw, uint32_t sh, uint8_t *dst,
                uint32_t dw, uint32_t dh) {
  for (uint32_t y = 0; y < dh; ++y) {
    const auto *source_row = src + static_cast<size_t>(y) * sh / dh * sw * 4;
    auto *destination_row = dst + static_cast<size_t>(y) * dw * 4;
    for (uint32_t x = 0; x < dw; ++x)
      std::memcpy(destination_row + x * 4,
                  source_row + (static_cast<size_t>(x) * sw / dw) * 4, 4);
  }
}

uint8_t clamp_byte(int value) {
  return static_cast<uint8_t>(std::clamp(value, 0, 255));
}
void bgra_to_nv12(const uint8_t *src, uint32_t width, uint32_t height,
                  uint8_t *dst) {
  auto *y_plane = dst;
  auto *uv_plane = dst + static_cast<size_t>(width) * height;
  for (uint32_t y = 0; y < height; ++y)
    for (uint32_t x = 0; x < width; ++x) {
      const auto *p = src + (static_cast<size_t>(y) * width + x) * 4;
      y_plane[static_cast<size_t>(y) * width + x] =
          clamp_byte(((66 * p[2] + 129 * p[1] + 25 * p[0] + 128) >> 8) + 16);
    }
  for (uint32_t y = 0; y < height; y += 2)
    for (uint32_t x = 0; x < width; x += 2) {
      int b = 0, g = 0, r = 0;
      for (uint32_t dy = 0; dy < 2; ++dy)
        for (uint32_t dx = 0; dx < 2; ++dx) {
          const auto *p =
              src + (static_cast<size_t>(y + dy) * width + x + dx) * 4;
          b += p[0];
          g += p[1];
          r += p[2];
        }
      b /= 4;
      g /= 4;
      r /= 4;
      const size_t offset = static_cast<size_t>(y / 2) * width + x;
      uv_plane[offset] =
          clamp_byte(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
      uv_plane[offset + 1] =
          clamp_byte(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
    }
}

std::string wide_to_utf8(const wchar_t *value) {
  if (!value)
    return {};
  const int count =
      WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (count <= 1)
    return {};
  std::string result(static_cast<size_t>(count), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), count, nullptr,
                      nullptr);
  result.pop_back();
  return result;
}

void enumerate_encoders() {
  check(MFStartup(MF_VERSION), "MFStartup");
  const GUID formats[] = {MFVideoFormat_H264};
  const char *names[] = {"H264"};
  for (size_t f = 0; f < std::size(formats); ++f) {
    MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, formats[f]};
    IMFActivate **activations = nullptr;
    UINT32 count = 0;
    const HRESULT hr =
        MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
                  MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, nullptr,
                  &output, &activations, &count);
    if (FAILED(hr) || count == 0)
      std::cout << "SKIP hardware_encoder codec=" << names[f]
                << " reason=none_enumerated\n";
    for (UINT32 i = 0; i < count; ++i) {
      wchar_t *friendly = nullptr;
      UINT32 length = 0;
      if (SUCCEEDED(activations[i]->GetAllocatedString(
              MFT_FRIENDLY_NAME_Attribute, &friendly, &length))) {
        std::cout << "CAPABILITY hardware_encoder codec=" << names[f]
                  << " name=\"" << wide_to_utf8(friendly) << "\"\n";
        CoTaskMemFree(friendly);
      }
      activations[i]->Release();
    }
    CoTaskMemFree(activations);
  }
  MFShutdown();
}

void wait_for_gpu(ID3D11DeviceContext *context, ID3D11Query *query) {
  context->End(query);
  while (context->GetData(query, nullptr, 0, 0) == S_FALSE)
    SwitchToThread();
}

HRESULT set_codec_uint32(IMFTransform *encoder, const GUID &key,
                         uint32_t value) {
  ComPtr<ICodecAPI> api;
  HRESULT hr = encoder->QueryInterface(IID_PPV_ARGS(&api));
  if (FAILED(hr))
    return hr;
  VARIANT setting{};
  setting.vt = VT_UI4;
  setting.ulVal = value;
  return api->SetValue(&key, &setting);
}

class TrackedBenchmarkInput final : public IMFAsyncCallback {
public:
  explicit TrackedBenchmarkInput(std::atomic_bool *available)
      : available_(available) {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **object) override {
    if (!object)
      return E_POINTER;
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IMFAsyncCallback)) {
      *object = static_cast<IMFAsyncCallback *>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }

  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = --references_;
    if (!remaining)
      delete this;
    return remaining;
  }

  HRESULT STDMETHODCALLTYPE GetParameters(DWORD *, DWORD *) override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE Invoke(IMFAsyncResult *) override {
    Complete();
    return S_OK;
  }

  void Complete() noexcept {
    if (!completed_.exchange(true))
      available_->store(true, std::memory_order_release);
  }

private:
  ~TrackedBenchmarkInput() { Complete(); }

  std::atomic<ULONG> references_{1};
  std::atomic_bool completed_{false};
  std::atomic_bool *available_;
};

void benchmark_hardware_encoder(
    const GUID &subtype, const char *codec, ID3D11Device *device,
    ID3D11DeviceContext *context, ID3D11VideoDevice *video_device,
    ID3D11VideoContext *video_context,
    ID3D11VideoProcessorEnumerator *enumerator, ID3D11VideoProcessor *processor,
    ID3D11VideoProcessorInputView *input_view, ID3D11Query *query,
    uint32_t width, uint32_t height, size_t frames) {
  MFT_REGISTER_TYPE_INFO output_registration{MFMediaType_Video, subtype};
  IMFActivate **activations = nullptr;
  UINT32 activation_count = 0;
  HRESULT hr =
      MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, nullptr,
                &output_registration, &activations, &activation_count);
  if (FAILED(hr) || !activation_count) {
    std::cout << "SKIP hardware_encode codec=" << codec
              << " reason=none_enumerated hresult=" << hr << '\n';
    CoTaskMemFree(activations);
    return;
  }
  ComPtr<IMFActivate> activation;
  activation.Attach(activations[0]);
  for (UINT32 i = 1; i < activation_count; ++i)
    activations[i]->Release();
  CoTaskMemFree(activations);
  const auto setup_begin = Clock::now();
  ComPtr<IMFTransform> encoder;
  hr = activation->ActivateObject(IID_PPV_ARGS(&encoder));
  if (FAILED(hr)) {
    std::cout << "SKIP hardware_encode codec=" << codec
              << " reason=activate_failed hresult=" << hr << '\n';
    return;
  }
  ComPtr<IMFAttributes> attributes;
  UINT32 asynchronous = FALSE;
  if (SUCCEEDED(encoder->GetAttributes(&attributes))) {
    attributes->GetUINT32(MF_TRANSFORM_ASYNC, &asynchronous);
    if (asynchronous &&
        FAILED(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE))) {
      std::cout << "SKIP hardware_encode codec=" << codec
                << " reason=async_unlock_rejected\n";
      activation->ShutdownObject();
      return;
    }
    attributes->SetUINT32(MF_LOW_LATENCY, TRUE);
  }
  ComPtr<IMFMediaEventGenerator> event_generator;
  ComPtr<IMFShutdown> shutdown;
  if (asynchronous &&
      (FAILED(encoder.As(&event_generator)) || FAILED(encoder.As(&shutdown)))) {
    std::cout << "SKIP hardware_encode codec=" << codec
              << " reason=async_interfaces_missing\n";
    activation->ShutdownObject();
    return;
  }
  UINT reset_token = 0;
  ComPtr<IMFDXGIDeviceManager> manager;
  hr = MFCreateDXGIDeviceManager(&reset_token, &manager);
  if (SUCCEEDED(hr))
    hr = manager->ResetDevice(device, reset_token);
  if (SUCCEEDED(hr))
    hr = encoder->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER,
                                 reinterpret_cast<ULONG_PTR>(manager.Get()));
  if (FAILED(hr)) {
    std::cout << "SKIP hardware_encode codec=" << codec
              << " reason=d3d_manager_rejected hresult=" << hr << '\n';
    activation->ShutdownObject();
    return;
  }
  ComPtr<IMFMediaType> output_type, input_type;
  check(MFCreateMediaType(&output_type), "MFCreateMediaType output");
  check(output_type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video),
        "Set output major type");
  check(output_type->SetGUID(MF_MT_SUBTYPE, subtype), "Set output subtype");
  check(MFSetAttributeSize(output_type.Get(), MF_MT_FRAME_SIZE, width, height),
        "Set output size");
  check(MFSetAttributeRatio(output_type.Get(), MF_MT_FRAME_RATE, 60, 1),
        "Set output fps");
  check(MFSetAttributeRatio(output_type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
        "Set output aspect");
  output_type->SetUINT32(MF_MT_AVG_BITRATE, 8'000'000);
  output_type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  output_type->SetUINT32(MF_MT_MPEG2_PROFILE,
                         eAVEncH264VProfile_ConstrainedBase);
  output_type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
  output_type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
  output_type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
  output_type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
  hr = encoder->SetOutputType(0, output_type.Get(), 0);
  if (FAILED(hr)) {
    std::cout << "SKIP hardware_encode codec=" << codec
              << " reason=output_type_rejected hresult=" << hr << '\n';
    activation->ShutdownObject();
    return;
  }
  check(MFCreateMediaType(&input_type), "MFCreateMediaType input");
  check(input_type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video),
        "Set input major type");
  check(input_type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12),
        "Set input subtype");
  check(MFSetAttributeSize(input_type.Get(), MF_MT_FRAME_SIZE, width, height),
        "Set input size");
  check(MFSetAttributeRatio(input_type.Get(), MF_MT_FRAME_RATE, 60, 1),
        "Set input fps");
  input_type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  input_type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
  input_type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
  input_type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
  input_type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
  hr = encoder->SetInputType(0, input_type.Get(), 0);
  if (FAILED(hr)) {
    std::cout << "SKIP hardware_encode codec=" << codec
              << " reason=nv12_input_type_rejected hresult=" << hr << '\n';
    activation->ShutdownObject();
    return;
  }
  const HRESULT low_latency_hr =
      set_codec_uint32(encoder.Get(), CODECAPI_AVLowLatencyMode, TRUE);
  const HRESULT rate_control_hr =
      set_codec_uint32(encoder.Get(), CODECAPI_AVEncCommonRateControlMode,
                       eAVEncCommonRateControlMode_CBR);
  const HRESULT bitrate_hr = set_codec_uint32(
      encoder.Get(), CODECAPI_AVEncCommonMeanBitRate, 8'000'000);
  const HRESULT b_frames_hr =
      set_codec_uint32(encoder.Get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0);
  std::cout << "CONFIG hardware_encode codec=" << codec
            << " low_latency_hr=" << low_latency_hr
            << " cbr_hr=" << rate_control_hr << " bitrate_hr=" << bitrate_hr
            << " b_frames_zero_hr=" << b_frames_hr << '\n';
  if (FAILED(low_latency_hr) || FAILED(rate_control_hr) || FAILED(bitrate_hr)) {
    std::cout << "SKIP hardware_encode codec=" << codec
              << " reason=required_codec_setting_rejected\n";
    activation->ShutdownObject();
    return;
  }
  encoder->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
  encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
  encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
  const auto setup_end = Clock::now();
  // Match the production WGC conversion pool so the stress test exercises
  // the same amount of backpressure and texture reuse.
  constexpr size_t pool_size = 5;
  std::array<std::atomic_bool, pool_size> slot_available;
  for (auto &available : slot_available)
    available.store(true, std::memory_order_relaxed);
  D3D11_TEXTURE2D_DESC texture_desc{};
  texture_desc.Width = width;
  texture_desc.Height = height;
  texture_desc.MipLevels = 1;
  texture_desc.ArraySize = 1;
  texture_desc.Format = DXGI_FORMAT_NV12;
  texture_desc.SampleDesc.Count = 1;
  texture_desc.Usage = D3D11_USAGE_DEFAULT;
  texture_desc.BindFlags = D3D11_BIND_RENDER_TARGET;
  std::vector<ComPtr<ID3D11Texture2D>> textures(pool_size);
  std::vector<ComPtr<ID3D11VideoProcessorOutputView>> views(pool_size);
  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC view_desc{};
  view_desc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  for (size_t i = 0; i < pool_size; ++i) {
    check(device->CreateTexture2D(&texture_desc, nullptr, &textures[i]),
          "Create encoder NV12 texture");
    check(video_device->CreateVideoProcessorOutputView(
              textures[i].Get(), enumerator, &view_desc, &views[i]),
          "Create encoder output view");
  }
  D3D11_VIDEO_PROCESSOR_STREAM stream{};
  stream.Enable = TRUE;
  stream.pInputSurface = input_view;
  MFT_OUTPUT_STREAM_INFO stream_info{};
  check(encoder->GetOutputStreamInfo(0, &stream_info), "GetOutputStreamInfo");
  uint64_t encoded_bytes = 0, keyframes = 0, output_units = 0;
  double submit_ms = 0, output_ms = 0;
  auto pull_output = [&]() -> HRESULT {
    ComPtr<IMFSample> sample;
    if (!(stream_info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
      check(MFCreateSample(&sample), "Create output sample");
      ComPtr<IMFMediaBuffer> buffer;
      check(MFCreateMemoryBuffer(
                std::max<DWORD>(stream_info.cbSize, 2 * 1024 * 1024), &buffer),
            "Create output buffer");
      check(sample->AddBuffer(buffer.Get()), "Add output buffer");
    }
    MFT_OUTPUT_DATA_BUFFER data{};
    data.dwStreamID = 0;
    data.pSample = sample.Get();
    DWORD status = 0;
    const auto output_begin = Clock::now();
    const HRESULT result = encoder->ProcessOutput(0, 1, &data, &status);
    const auto output_end = Clock::now();
    output_ms +=
        std::chrono::duration<double, std::milli>(output_end - output_begin)
            .count();
    if (SUCCEEDED(result)) {
      IMFSample *actual = data.pSample ? data.pSample : sample.Get();
      DWORD length = 0;
      if (actual && SUCCEEDED(actual->GetTotalLength(&length)))
        encoded_bytes += length;
      UINT32 clean = FALSE;
      if (actual &&
          SUCCEEDED(actual->GetUINT32(MFSampleExtension_CleanPoint, &clean)) &&
          clean)
        ++keyframes;
      ++output_units;
    }
    if (data.pEvents)
      data.pEvents->Release();
    if (data.pSample && data.pSample != sample.Get())
      data.pSample->Release();
    return result;
  };
  size_t need_input_events = 0;
  bool drain_complete = false;
  auto pump_async_event = [&]() -> HRESULT {
    ComPtr<IMFMediaEvent> event;
    const HRESULT event_hr =
        event_generator->GetEvent(MF_EVENT_FLAG_NO_WAIT, &event);
    if (event_hr == MF_E_NO_EVENTS_AVAILABLE)
      return S_FALSE;
    if (FAILED(event_hr))
      return event_hr;
    HRESULT status = S_OK;
    MediaEventType type = MEUnknown;
    if (FAILED(event->GetStatus(&status)))
      return E_FAIL;
    if (FAILED(status))
      return status;
    if (FAILED(event->GetType(&type)))
      return E_FAIL;
    if (type == METransformHaveOutput)
      return pull_output();
    if (type == METransformNeedInput)
      ++need_input_events;
    else if (type == METransformDrainComplete)
      drain_complete = true;
    return S_OK;
  };
  auto wait_for_async_input = [&]() -> bool {
    const auto deadline = Clock::now() + std::chrono::seconds(2);
    while (Clock::now() < deadline) {
      if (need_input_events) {
        --need_input_events;
        return true;
      }
      const HRESULT event_hr = pump_async_event();
      if (event_hr == S_FALSE) {
        Sleep(1);
        continue;
      }
      if (FAILED(event_hr))
        return false;
    }
    return false;
  };
  auto wait_for_slot = [&](size_t slot) -> bool {
    const auto deadline = Clock::now() + std::chrono::seconds(2);
    while (Clock::now() < deadline) {
      if (slot_available[slot].load(std::memory_order_acquire))
        return true;
      if (asynchronous) {
        const HRESULT event_hr = pump_async_event();
        if (FAILED(event_hr) && event_hr != MF_E_TRANSFORM_NEED_MORE_INPUT)
          return false;
      } else {
        const HRESULT output_hr = pull_output();
        if (FAILED(output_hr) && output_hr != MF_E_TRANSFORM_NEED_MORE_INPUT)
          return false;
      }
      Sleep(1);
    }
    return false;
  };
  auto wait_for_async_drain = [&]() -> bool {
    const auto deadline = Clock::now() + std::chrono::seconds(2);
    while (Clock::now() < deadline) {
      if (drain_complete)
        return true;
      const HRESULT event_hr = pump_async_event();
      if (event_hr == S_FALSE) {
        Sleep(1);
        continue;
      }
      if (FAILED(event_hr) && event_hr != MF_E_TRANSFORM_NEED_MORE_INPUT)
        return false;
    }
    return false;
  };
  auto wait_for_released_slot = [&](size_t slot) -> bool {
    const auto deadline = Clock::now() + std::chrono::seconds(2);
    while (Clock::now() < deadline) {
      if (slot_available[slot].load(std::memory_order_acquire))
        return true;
      Sleep(1);
    }
    return false;
  };
  const auto total_begin = Clock::now();
  size_t submitted = 0;
  bool forced_late_join_keyframe = false;
  for (size_t frame = 0; frame < frames; ++frame) {
    if (asynchronous && !wait_for_async_input()) {
      throw std::runtime_error(std::string(codec) +
                               " async encoder timed out waiting for input");
    }
    const size_t slot = frame % pool_size;
    if (!wait_for_slot(slot))
      throw std::runtime_error(std::string(codec) +
                               " encoder retained an NV12 pool slot");
    slot_available[slot].store(false, std::memory_order_release);
    check(video_context->VideoProcessorBlt(
              processor, views[slot].Get(), 0, 1, &stream),
          "Encoder VideoProcessorBlt");
    wait_for_gpu(context, query);
    ComPtr<IMFMediaBuffer> surface;
    hr = MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D),
                                   textures[slot].Get(), 0, FALSE, &surface);
    if (FAILED(hr)) {
      std::cout << "SKIP hardware_encode codec=" << codec
                << " reason=dxgi_surface_buffer_failed hresult=" << hr << '\n';
      encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
      activation->ShutdownObject();
      return;
    }
    ComPtr<IMFTrackedSample> tracked_sample;
    check(MFCreateTrackedSample(&tracked_sample), "Create tracked input sample");
    ComPtr<IMFSample> sample;
    check(tracked_sample.As(&sample), "Query tracked input IMFSample");
    check(sample->AddBuffer(surface.Get()), "Add DXGI input buffer");
    sample->SetSampleTime(static_cast<LONGLONG>(frame) * 10'000'000 / 60);
    sample->SetSampleDuration(10'000'000 / 60);
    ComPtr<TrackedBenchmarkInput> lease;
    lease.Attach(new TrackedBenchmarkInput(&slot_available[slot]));
    check(tracked_sample->SetAllocator(lease.Get(), nullptr),
          "Track encoder input sample");
    if (frames > 1 && frame == frames / 2) {
      check(set_codec_uint32(encoder.Get(), CODECAPI_AVEncVideoForceKeyFrame,
                             TRUE),
            "Force late-join keyframe");
      forced_late_join_keyframe = true;
    }
    auto submit_begin = Clock::now();
    hr = encoder->ProcessInput(0, sample.Get(), 0);
    auto submit_end = Clock::now();
    submit_ms +=
        std::chrono::duration<double, std::milli>(submit_end - submit_begin)
            .count();
    while (hr == MF_E_NOTACCEPTING) {
      const HRESULT out = pull_output();
      if (out == MF_E_TRANSFORM_NEED_MORE_INPUT)
        break;
      submit_begin = Clock::now();
      hr = encoder->ProcessInput(0, sample.Get(), 0);
      submit_end = Clock::now();
      submit_ms +=
          std::chrono::duration<double, std::milli>(submit_end - submit_begin)
              .count();
    }
    if (FAILED(hr)) {
      std::cout << "SKIP hardware_encode codec=" << codec
                << " reason=dxgi_process_input_rejected hresult=" << hr
                << " submitted=" << submitted << '\n';
      encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
      activation->ShutdownObject();
      return;
    }
    ++submitted;
    if (!asynchronous)
      while (pull_output() == S_OK) {
      }
  }
  const auto drain_begin = Clock::now();
  encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
  encoder->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
  if (asynchronous) {
    if (!wait_for_async_drain())
      throw std::runtime_error(std::string(codec) +
                               " async encoder drain timed out");
  } else {
    while (pull_output() == S_OK) {
    }
  }
  encoder->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
  encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
  if (shutdown)
    shutdown->Shutdown();
  check(activation->ShutdownObject(), "Shutdown hardware encoder");
  for (size_t slot = 0; slot < pool_size; ++slot)
    if (!wait_for_released_slot(slot))
      throw std::runtime_error(std::string(codec) +
                               " retained an input sample after shutdown");
  const auto drain_end = Clock::now();
  const auto total_end = drain_end;
  if (!output_units || !encoded_bytes)
    throw std::runtime_error(std::string(codec) +
                             " hardware encoder produced no access units");
  if (forced_late_join_keyframe && keyframes < 2)
    throw std::runtime_error(
        std::string(codec) +
        " hardware encoder did not produce the requested late-join keyframe");
  const double total_ms =
      std::chrono::duration<double, std::milli>(total_end - total_begin)
          .count();
  std::cout
      << "RESULT path=hardware_encode codec=" << codec
      << " frames=" << submitted << " access_units=" << output_units
      << " setup_ms="
      << std::chrono::duration<double, std::milli>(setup_end - setup_begin)
             .count()
      << " submit_total_ms=" << submit_ms
      << " submit_avg_ms=" << (submit_ms / submitted)
      << " output_total_ms=" << output_ms << " drain_ms="
      << std::chrono::duration<double, std::milli>(drain_end - drain_begin)
             .count()
      << " total_ms=" << total_ms << " fps=" << (submitted * 1000.0 / total_ms)
      << " encoded_bytes=" << encoded_bytes << " keyframes=" << keyframes
      << " cpu_copy_bytes_per_frame=0\n";
  std::cout << "ASSERT hardware_encode codec=" << codec
            << " nonempty_access_units=pass clean_shutdown=pass"
               " tracked_input_lifetime=pass late_join_keyframe=pass\n";
}
} // namespace

int main(int argc, char **argv) try {
  std::cout << std::unitbuf;
  const uint32_t sw =
      argc > 1 ? static_cast<uint32_t>(std::stoul(argv[1])) : 1920;
  const uint32_t sh =
      argc > 2 ? static_cast<uint32_t>(std::stoul(argv[2])) : 1080;
  const uint32_t dw =
      argc > 3 ? static_cast<uint32_t>(std::stoul(argv[3])) : 1280;
  const uint32_t dh =
      argc > 4 ? static_cast<uint32_t>(std::stoul(argv[4])) : 720;
  const size_t iterations = argc > 5 ? std::stoul(argv[5]) : 120;
  const std::string capture_source = argc > 7 ? argv[7] : "screen:1";
  const std::uint32_t preview_target_pid = argc > 8
      ? static_cast<std::uint32_t>(std::stoul(argv[8]))
      : static_cast<std::uint32_t>(GetCurrentProcessId());
  if (!sw || !sh || !dw || !dh || !iterations || (dw & 1) || (dh & 1))
    throw std::runtime_error("dimensions/iterations must be non-zero and NV12 "
                             "output dimensions even");
  check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "CoInitializeEx");
  std::cout << "CONTEXT input=" << sw << 'x' << sh << " output=" << dw << 'x'
            << dh << " iterations=" << iterations << '\n';

  std::vector<uint8_t> source(static_cast<size_t>(sw) * sh * 4),
      copy(source.size()), scaled(static_cast<size_t>(dw) * dh * 4);
  for (uint32_t y = 0; y < sh; ++y)
    for (uint32_t x = 0; x < sw; ++x) {
      auto *p = source.data() + (static_cast<size_t>(y) * sw + x) * 4;
      p[0] = x & 255;
      p[1] = y & 255;
      p[2] = (x ^ y) & 255;
      p[3] = 255;
    }
  auto timed = [&](const std::string &name, uint64_t bytes, auto &&action,
                   const uint8_t *output, size_t output_size) {
    action();
    const auto begin = Clock::now();
    for (size_t i = 0; i < iterations; ++i)
      action();
    const auto end = Clock::now();
    print_result(
        {name, std::chrono::duration<double, std::milli>(end - begin).count(),
         iterations, bytes * iterations, checksum(output, output_size)});
  };
  timed(
      "cpu_bgra_copy", source.size(),
      [&] { std::memcpy(copy.data(), source.data(), source.size()); },
      copy.data(), copy.size());
  if (copy != source)
    throw std::runtime_error("CPU BGRA copy correctness check failed");
  timed(
      "cpu_bgra_scale_nearest", source.size() + scaled.size(),
      [&] { scale_bgra(source.data(), sw, sh, scaled.data(), dw, dh); },
      scaled.data(), scaled.size());
  std::vector<uint8_t> nv12(static_cast<size_t>(dw) * dh * 3 / 2);
  timed(
      "cpu_bgra_to_nv12", scaled.size() + nv12.size(),
      [&] { bgra_to_nv12(scaled.data(), dw, dh, nv12.data()); }, nv12.data(),
      nv12.size());
  if (checksum(scaled.data(), scaled.size()) == 0 ||
      checksum(nv12.data(), nv12.size()) == 0)
    throw std::runtime_error("CPU conversion correctness checksum failed");
  std::cout << "ASSERT cpu_output_dimensions=" << dw << 'x' << dh
            << " copy_equal=pass checksum_nonzero=pass\n";

  if (argc > 6 && std::string(argv[6]) == "--capture") {
    using namespace syrnike::voice;
    const auto target = resolveScreenCaptureTarget(capture_source);
    auto capturer = ScreenVideoCapturer::create(target, dw, dh);
    ScreenVideoFrame frame;
    size_t captured = 0;
    uint64_t capture_us = 0, readback_us = 0, scale_us = 0, bytes = 0;
    const auto capture_begin = Clock::now();
    while (Clock::now() - capture_begin < std::chrono::seconds(5)) {
      const auto result = capturer->capture(frame);
      if (result.status == ScreenCaptureFrameStatus::NewFrame ||
          result.status == ScreenCaptureFrameStatus::RepeatedFrame) {
        ++captured;
        capture_us += result.metrics.capture_us;
        readback_us += result.metrics.readback_us;
        scale_us += result.metrics.scale_us;
        bytes += frame.bgra.size();
      } else if (result.status == ScreenCaptureFrameStatus::FatalError ||
                 result.status == ScreenCaptureFrameStatus::TargetClosed) {
        std::cout << "SKIP real_screen_capture reason=status_"
                  << static_cast<int>(result.status)
                  << " hresult=" << result.metrics.hresult << '\n';
        break;
      }
      Sleep(16);
    }
    if (captured) {
      if (frame.bgra.size() != static_cast<size_t>(dw) * dh * 4)
        throw std::runtime_error("real capture output dimensions mismatch");
      std::cout << "RESULT path=real_screen_capture method="
                << capturer->method() << " frames=" << captured
                << " avg_capture_ms=" << (capture_us / captured / 1000.0)
                << " avg_readback_ms=" << (readback_us / captured / 1000.0)
                << " avg_scale_ms=" << (scale_us / captured / 1000.0)
                << " cpu_copy_bytes_per_frame=" << (bytes / captured)
                << " checksum="
                << checksum(frame.bgra.data(), frame.bgra.size()) << '\n';
    } else
      std::cout << "SKIP real_screen_capture reason=no_frames\n";
  }

  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL level{};
  check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                          D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                          D3D11_SDK_VERSION, &device, &level, &context),
        "D3D11CreateDevice");
  ComPtr<IDXGIDevice> dxgi_device;
  check(device.As(&dxgi_device), "IDXGIDevice");
  ComPtr<IDXGIAdapter> adapter;
  check(dxgi_device->GetAdapter(&adapter), "GetAdapter");
  DXGI_ADAPTER_DESC desc{};
  check(adapter->GetDesc(&desc), "GetDesc");
  std::cout << "CONTEXT gpu=\"" << wide_to_utf8(desc.Description)
            << "\" vendor_id=0x" << std::hex << desc.VendorId << std::dec
            << " feature_level=0x" << std::hex << level << std::dec << '\n';

  if (argc > 6 && std::string(argv[6]) == "--capture") {
    using namespace syrnike::desktop_native::media;
    const auto target =
        syrnike::voice::resolveScreenCaptureTarget(capture_source);
    auto capturer = ScreenGpuCapturer::create(target, dw, dh);
    capturer->setPreviewDemand({
        true,
        sw,
        sh,
        60,
        preview_target_pid,
    });
    ScreenGpuFrame frame;
    std::size_t captured = 0;
    std::uint64_t gpu_sum = 0;
    std::uint64_t preview_sum = 0;
    const auto external_preview = preview_target_pid != GetCurrentProcessId();
    const auto target_capture_frames = external_preview ? iterations : 1;
    const auto deadline = Clock::now() + std::chrono::seconds(15);
    while (Clock::now() < deadline && captured < target_capture_frames) {
      const auto result = capturer->capture(frame);
      if (result.status == ScreenGpuFrameStatus::NewFrame) {
        ComPtr<ID3D11Device1> device1;
        check(device.As(&device1), "ID3D11Device1 for shared GPU capture");
        ComPtr<ID3D11Texture2D> shared;
        const HRESULT open = device1->OpenSharedResource1(
            frame.shared_texture_handle, IID_PPV_ARGS(&shared));
        if (FAILED(open)) {
          capturer->discard(frame);
          throw std::runtime_error("failed to open GPU capture shared texture");
        }
        ComPtr<IDXGIKeyedMutex> keyed;
        check(shared.As(&keyed), "GPU capture keyed mutex");
        check(keyed->AcquireSync(1, 1'000), "Acquire GPU capture consumer key");
        D3D11_TEXTURE2D_DESC shared_desc{};
        shared->GetDesc(&shared_desc);
        if (shared_desc.Width != dw || shared_desc.Height != dh ||
            shared_desc.Format != DXGI_FORMAT_NV12) {
          keyed->ReleaseSync(0);
          throw std::runtime_error("GPU capture output format mismatch");
        }
        D3D11_TEXTURE2D_DESC readback_desc = shared_desc;
        readback_desc.Usage = D3D11_USAGE_STAGING;
        readback_desc.BindFlags = 0;
        readback_desc.MiscFlags = 0;
        readback_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Texture2D> readback;
        check(device->CreateTexture2D(&readback_desc, nullptr, &readback),
              "Create GPU capture verification texture");
        context->CopyResource(readback.Get(), shared.Get());
        D3D11_MAPPED_SUBRESOURCE mapped{};
        check(context->Map(readback.Get(), 0, D3D11_MAP_READ, 0, &mapped),
              "Map GPU capture verification texture");
        std::vector<std::uint8_t> bytes(static_cast<std::size_t>(dw) * dh * 3 /
                                        2);
        for (std::uint32_t row = 0; row < dh * 3 / 2; ++row) {
          std::memcpy(bytes.data() + static_cast<std::size_t>(row) * dw,
                      static_cast<const std::uint8_t *>(mapped.pData) +
                          static_cast<std::size_t>(row) * mapped.RowPitch,
                      dw);
        }
        context->Unmap(readback.Get(), 0);
        check(keyed->ReleaseSync(0), "Release GPU capture producer key");
        gpu_sum = checksum(bytes.data(), bytes.size());

        ScreenPreviewFrame preview;
        if (!capturer->takePreviewFrame(preview)) {
          capturer->discard(frame);
          Sleep(1);
          continue;
        }
        ++captured;
        std::cout << "RESULT path=real_screen_gpu_capture method="
                  << result.method << " frames=" << captured
                  << " capture_ms=" << (result.metrics.capture_us / 1000.0)
                  << " gpu_convert_submit_ms="
                  << (result.metrics.scale_us / 1000.0)
                  << " cpu_copy_bytes_per_frame=0 checksum=" << gpu_sum << '\n';
        if (external_preview) {
          std::cout << "EXTERNAL_PREVIEW nt_handle=" << preview.nt_handle
                    << " sequence=" << preview.sequence
                    << " width=" << preview.width
                    << " height=" << preview.height << std::endl;
          capturer->discard(frame);
          std::string release_command;
          if (!std::getline(std::cin, release_command) ||
              release_command !=
                  "RELEASE " + std::to_string(preview.sequence)) {
            throw std::runtime_error(
                "Electron did not acknowledge the preview release fence");
          }
          capturer->releasePreviewFrame(preview.sequence);
          preview_sum = 1;
          continue;
        }
        ComPtr<ID3D11Texture2D> preview_texture;
        const HRESULT open_preview = device1->OpenSharedResource1(
            reinterpret_cast<HANDLE>(preview.nt_handle),
            IID_PPV_ARGS(&preview_texture));
        if (FAILED(open_preview)) {
          capturer->releasePreviewFrame(preview.sequence);
          capturer->discard(frame);
          throw std::runtime_error(
              "failed to open BGRA preview shared texture (HRESULT " +
              std::to_string(open_preview) + ")");
        }
        D3D11_TEXTURE2D_DESC preview_desc{};
        preview_texture->GetDesc(&preview_desc);
        if (preview_desc.Width != dw || preview_desc.Height != dh ||
            preview_desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
          capturer->releasePreviewFrame(preview.sequence);
          capturer->discard(frame);
          throw std::runtime_error("GPU preview output format mismatch");
        }
        D3D11_TEXTURE2D_DESC preview_readback_desc = preview_desc;
        preview_readback_desc.Usage = D3D11_USAGE_STAGING;
        preview_readback_desc.BindFlags = 0;
        preview_readback_desc.MiscFlags = 0;
        preview_readback_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Texture2D> preview_readback;
        check(device->CreateTexture2D(
                  &preview_readback_desc, nullptr, &preview_readback),
              "Create GPU preview verification texture");
        context->CopyResource(preview_readback.Get(), preview_texture.Get());
        D3D11_MAPPED_SUBRESOURCE preview_mapped{};
        check(context->Map(
                  preview_readback.Get(), 0, D3D11_MAP_READ, 0,
                  &preview_mapped),
              "Map GPU preview verification texture");
        std::vector<std::uint8_t> preview_bytes(
            static_cast<std::size_t>(dw) * dh * 4);
        for (std::uint32_t row = 0; row < dh; ++row) {
          std::memcpy(
              preview_bytes.data() + static_cast<std::size_t>(row) * dw * 4,
              static_cast<const std::uint8_t*>(preview_mapped.pData) +
                  static_cast<std::size_t>(row) * preview_mapped.RowPitch,
              static_cast<std::size_t>(dw) * 4);
        }
        context->Unmap(preview_readback.Get(), 0);
        preview_sum = checksum(preview_bytes.data(), preview_bytes.size());
        capturer->releasePreviewFrame(preview.sequence);
        capturer->discard(frame);
        std::cout << "RESULT path=local_screen_gpu_preview method="
                  << result.method << " frames=1 dimensions=" << preview.width
                  << 'x' << preview.height
                  << " cpu_copy_bytes_per_frame=0 checksum=" << preview_sum
                  << '\n';
      } else if (result.status == ScreenGpuFrameStatus::FatalError ||
                 result.status == ScreenGpuFrameStatus::TargetClosed) {
        throw std::runtime_error("strict GPU screen capture failed");
      }
      Sleep(1);
    }
    if (captured != target_capture_frames || gpu_sum == 0 || preview_sum == 0) {
      throw std::runtime_error(
          "strict GPU screen capture/preview produced no verifiable frame");
    }
    std::cout << "ASSERT real_screen_gpu_capture nv12_shared_texture=pass "
                 "bgra_preview_shared_texture=pass "
                 "cpu_readback_in_timed_path=absent\n";
    if (preview_target_pid == GetCurrentProcessId()) {
      struct CapturePhase {
        std::size_t capture_calls = 0;
        std::size_t preview_frames = 0;
        double call_ms = 0;
      };
      const auto measure_phase = [&](bool preview_enabled) {
        capturer->setPreviewDemand({
            preview_enabled,
            dw,
            dh,
            60,
            static_cast<std::uint32_t>(GetCurrentProcessId()),
        });
        CapturePhase phase;
        const auto phase_begin = Clock::now();
        const auto phase_deadline = phase_begin + std::chrono::seconds(5);
        const auto target_frames = std::max<std::size_t>(60, iterations);
        while (Clock::now() < phase_deadline &&
               phase.capture_calls < target_frames) {
          ScreenGpuFrame phase_frame;
          const auto call_begin = Clock::now();
          const auto result = capturer->capture(phase_frame);
          const auto call_end = Clock::now();
          if (result.status == ScreenGpuFrameStatus::NewFrame) {
            ++phase.capture_calls;
            phase.call_ms += std::chrono::duration<double, std::milli>(
                                 call_end - call_begin)
                                 .count();
            capturer->discard(phase_frame);
          } else if (result.status == ScreenGpuFrameStatus::FatalError ||
                     result.status == ScreenGpuFrameStatus::TargetClosed) {
            throw std::runtime_error("GPU preview steady-state capture failed");
          }
          ScreenPreviewFrame phase_preview;
          if (capturer->takePreviewFrame(phase_preview)) {
            ++phase.preview_frames;
            capturer->releasePreviewFrame(phase_preview.sequence);
          }
          Sleep(1);
        }
        if (phase.capture_calls == 0 ||
            (preview_enabled && phase.preview_frames == 0)) {
          throw std::runtime_error("GPU preview steady-state sample is empty");
        }
        return phase;
      };

      const auto without_preview = measure_phase(false);
      const auto with_preview = measure_phase(true);
      const auto without_preview_avg =
          without_preview.call_ms / without_preview.capture_calls;
      const auto with_preview_avg = with_preview.call_ms / with_preview.capture_calls;
      const auto overhead_per_capture_ms = with_preview_avg - without_preview_avg;
      const auto overhead_per_preview_ms =
          (with_preview.call_ms - without_preview_avg * with_preview.capture_calls) /
          with_preview.preview_frames;
      std::cout << "RESULT path=local_screen_gpu_preview_steady fps_limit=60 "
                << "preview_frames=" << with_preview.preview_frames
                << " capture_calls=" << with_preview.capture_calls
                << " baseline_call_avg_ms=" << without_preview_avg
                << " preview_call_avg_ms=" << with_preview_avg
                << " overhead_per_capture_ms=" << overhead_per_capture_ms
                << " overhead_per_preview_frame_ms=" << overhead_per_preview_ms
                << " cpu_copy_bytes_per_frame=0\n";
    }
  }
  D3D11_QUERY_DESC query_desc{D3D11_QUERY_EVENT, 0};
  ComPtr<ID3D11Query> query;
  check(device->CreateQuery(&query_desc, &query), "CreateQuery");
  D3D11_TEXTURE2D_DESC texture_desc{};
  texture_desc.Width = sw;
  texture_desc.Height = sh;
  texture_desc.MipLevels = 1;
  texture_desc.ArraySize = 1;
  texture_desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  texture_desc.SampleDesc.Count = 1;
  texture_desc.Usage = D3D11_USAGE_DEFAULT;
  texture_desc.BindFlags =
      D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  ComPtr<ID3D11Texture2D> gpu_source, gpu_copy;
  check(device->CreateTexture2D(&texture_desc, nullptr, &gpu_source),
        "Create source texture");
  check(device->CreateTexture2D(&texture_desc, nullptr, &gpu_copy),
        "Create copy texture");
  context->UpdateSubresource(gpu_source.Get(), 0, nullptr, source.data(),
                             sw * 4, 0);
  context->CopyResource(gpu_copy.Get(), gpu_source.Get());
  wait_for_gpu(context.Get(), query.Get());
  auto begin = Clock::now();
  for (size_t i = 0; i < iterations; ++i)
    context->CopyResource(gpu_copy.Get(), gpu_source.Get());
  wait_for_gpu(context.Get(), query.Get());
  auto end = Clock::now();
  print_result({"gpu_bgra_copy",
                std::chrono::duration<double, std::milli>(end - begin).count(),
                iterations, 0, checksum(source.data(), source.size())});

  ComPtr<ID3D11VideoDevice> video_device;
  ComPtr<ID3D11VideoContext> video_context;
  if (FAILED(device.As(&video_device)) || FAILED(context.As(&video_context))) {
    std::cout << "SKIP gpu_video_processor_bgra_to_nv12 "
                 "reason=no_d3d11_video_interfaces\n";
  } else {
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = sw;
    content.InputHeight = sh;
    content.OutputWidth = dw;
    content.OutputHeight = dh;
    content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    HRESULT hr =
        video_device->CreateVideoProcessorEnumerator(&content, &enumerator);
    UINT input_flags = 0, output_flags = 0;
    if (SUCCEEDED(hr))
      hr = enumerator->CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM,
                                                 &input_flags);
    if (SUCCEEDED(hr))
      hr = enumerator->CheckVideoProcessorFormat(DXGI_FORMAT_NV12,
                                                 &output_flags);
    if (FAILED(hr) ||
        !(input_flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) ||
        !(output_flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) {
      std::cout << "SKIP gpu_video_processor_bgra_to_nv12 "
                   "reason=format_not_supported\n";
    } else {
      ComPtr<ID3D11VideoProcessor> processor;
      check(video_device->CreateVideoProcessor(enumerator.Get(), 0, &processor),
            "CreateVideoProcessor");
      D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC ivd{};
      ivd.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
      ivd.Texture2D.ArraySlice = 0;
      ComPtr<ID3D11VideoProcessorInputView> input_view;
      check(video_device->CreateVideoProcessorInputView(
                gpu_source.Get(), enumerator.Get(), &ivd, &input_view),
            "Create input view");
      D3D11_TEXTURE2D_DESC out_desc = texture_desc;
      out_desc.Width = dw;
      out_desc.Height = dh;
      out_desc.Format = DXGI_FORMAT_NV12;
      out_desc.BindFlags = D3D11_BIND_RENDER_TARGET;
      ComPtr<ID3D11Texture2D> output;
      check(device->CreateTexture2D(&out_desc, nullptr, &output),
            "Create NV12 output");
      D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ovd{};
      ovd.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
      ComPtr<ID3D11VideoProcessorOutputView> output_view;
      check(video_device->CreateVideoProcessorOutputView(
                output.Get(), enumerator.Get(), &ovd, &output_view),
            "Create output view");
      RECT src_rect{0, 0, static_cast<LONG>(sw), static_cast<LONG>(sh)},
          dst_rect{0, 0, static_cast<LONG>(dw), static_cast<LONG>(dh)};
      video_context->VideoProcessorSetStreamSourceRect(processor.Get(), 0, TRUE,
                                                       &src_rect);
      video_context->VideoProcessorSetStreamDestRect(processor.Get(), 0, TRUE,
                                                     &dst_rect);
      video_context->VideoProcessorSetOutputTargetRect(processor.Get(), TRUE,
                                                       &dst_rect);
      D3D11_VIDEO_PROCESSOR_STREAM stream{};
      stream.Enable = TRUE;
      stream.pInputSurface = input_view.Get();
      check(video_context->VideoProcessorBlt(processor.Get(), output_view.Get(),
                                             0, 1, &stream),
            "VideoProcessorBlt warmup");
      wait_for_gpu(context.Get(), query.Get());
      begin = Clock::now();
      for (size_t i = 0; i < iterations; ++i)
        check(video_context->VideoProcessorBlt(
                  processor.Get(), output_view.Get(), 0, 1, &stream),
              "VideoProcessorBlt");
      wait_for_gpu(context.Get(), query.Get());
      end = Clock::now();
      D3D11_TEXTURE2D_DESC staging_desc = out_desc;
      staging_desc.Usage = D3D11_USAGE_STAGING;
      staging_desc.BindFlags = 0;
      staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      ComPtr<ID3D11Texture2D> staging;
      check(device->CreateTexture2D(&staging_desc, nullptr, &staging),
            "Create NV12 staging texture");
      context->CopyResource(staging.Get(), output.Get());
      D3D11_MAPPED_SUBRESOURCE mapped{};
      check(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped),
            "Map NV12 staging texture");
      std::vector<uint8_t> gpu_nv12(static_cast<size_t>(dw) * dh * 3 / 2);
      for (uint32_t row = 0; row < dh * 3 / 2; ++row)
        std::memcpy(gpu_nv12.data() + static_cast<size_t>(row) * dw,
                    static_cast<const uint8_t *>(mapped.pData) +
                        static_cast<size_t>(row) * mapped.RowPitch,
                    dw);
      context->Unmap(staging.Get(), 0);
      const uint64_t gpu_sum = checksum(gpu_nv12.data(), gpu_nv12.size());
      if (gpu_sum == 0)
        throw std::runtime_error("GPU NV12 output checksum unexpectedly zero");
      print_result(
          {"gpu_video_processor_bgra_to_nv12",
           std::chrono::duration<double, std::milli>(end - begin).count(),
           iterations, 0, gpu_sum});
      std::cout << "ASSERT gpu_video_processor_output_dimensions=" << dw << 'x'
                << dh << " status=pass checksum_nonzero=pass\n";
      check(MFStartup(MF_VERSION), "MFStartup encoder benchmark");
      benchmark_hardware_encoder(
          MFVideoFormat_H264, "H264", device.Get(), context.Get(),
          video_device.Get(), video_context.Get(), enumerator.Get(),
          processor.Get(), input_view.Get(), query.Get(), dw, dh, iterations);
      MFShutdown();
    }
  }
  enumerate_encoders();
  CoUninitialize();
  return 0;
} catch (const std::exception &error) {
  std::cerr << "FAIL " << error.what() << '\n';
  return 1;
}
