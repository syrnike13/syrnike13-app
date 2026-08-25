#include "camera_capture.hpp"

#include <windows.h>
#include <d3d10_1.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <livekit/d3d11_h264_video_source.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <iomanip>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <utility>

#include "../common/diagnostic_log.hpp"
#include "camera_device_notification.hpp"
#include "d3d11_gpu_completion.hpp"
#include "video_resource_admission.hpp"

namespace syrnike::desktop_native::media {
namespace {
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;

constexpr DWORD kVideoStream =
    static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM);
constexpr UINT64 kProducerKey = 0;
constexpr UINT64 kConsumerKey = 1;
constexpr std::size_t kGpuPoolSize = 5;
constexpr auto kReadPoll = std::chrono::milliseconds(100);
constexpr auto kFrameWatchdog = std::chrono::seconds(2);
constexpr auto kFlushDeadline = std::chrono::milliseconds(750);

std::shared_ptr<VideoResourceLease> acquireCameraResource(
    VideoResourceAdmissionBudget& budget,
    const VideoResourceRequest& request) {
  try {
    return requireVideoResourceAdmission(budget, request);
  } catch (const VideoResourceSaturationError& error) {
    const auto& saturation = error.saturation();
    diagnostics::DiagnosticLog::instance().write(
        "camera_video_resource_saturated",
        {
            {"owner", videoResourceOwnerName(saturation.owner)},
            {"ownerId", saturation.owner_id},
            {"resourceClass",
             videoResourceClassName(saturation.resource_class)},
            {"current", saturation.current},
            {"requested", saturation.requested},
            {"limit", saturation.limit},
        });
    throw;
  }
}

[[noreturn]] void fail(HRESULT result, const char* message) {
  std::ostringstream output;
  output << message << " (HRESULT=0x" << std::hex << std::setw(8)
         << std::setfill('0') << static_cast<std::uint32_t>(result) << ')';
  throw std::runtime_error(output.str());
}

void check(HRESULT result, const char* message) {
  if (FAILED(result)) fail(result, message);
}

struct ActivateArray {
  IMFActivate** values = nullptr;
  UINT32 count = 0;

  ~ActivateArray() {
    for (UINT32 index = 0; index < count; ++index) {
      if (values[index]) values[index]->Release();
    }
    CoTaskMemFree(values);
  }
};

double framesPerSecond(const CameraFormat& format) {
  if (format.frame_rate_denominator == 0) return 0.0;
  return static_cast<double>(format.frame_rate_numerator) /
      static_cast<double>(format.frame_rate_denominator);
}

bool validFormat(const CameraFormat& format) {
  return format.width > 0 && format.height > 0 &&
      format.frame_rate_numerator > 0 &&
      format.frame_rate_denominator > 0;
}

std::size_t checkedCameraRowBytes(std::uint32_t width) {
  if (width == 0 ||
      width > std::numeric_limits<std::size_t>::max() / 4) {
    throw std::overflow_error("camera row size overflow");
  }
  return static_cast<std::size_t>(width) * 4;
}

std::size_t checkedAbsoluteStride(std::ptrdiff_t stride) {
  if (stride == std::numeric_limits<std::ptrdiff_t>::min()) {
    throw std::overflow_error("camera frame stride overflow");
  }
  return static_cast<std::size_t>(stride < 0 ? -stride : stride);
}

std::size_t checkedCameraFrameBytes(
    std::size_t absolute_stride,
    std::size_t row_bytes,
    std::uint32_t height) {
  if (height == 0 || absolute_stride < row_bytes) {
    throw std::invalid_argument("camera frame stride is too small");
  }
  const auto preceding_rows = static_cast<std::size_t>(height - 1);
  if (preceding_rows >
      (std::numeric_limits<std::size_t>::max() - row_bytes) /
          absolute_stride) {
    throw std::overflow_error("camera frame size overflow");
  }
  return absolute_stride * preceding_rows + row_bytes;
}

double formatDistance(
    const CameraFormat& candidate,
    const CameraFormat& requested) {
  const auto width_ratio =
      static_cast<double>(candidate.width) / requested.width;
  const auto height_ratio =
      static_cast<double>(candidate.height) / requested.height;
  const auto requested_fps = framesPerSecond(requested);
  const auto fps_distance = requested_fps > 0.0
      ? std::abs(framesPerSecond(candidate) - requested_fps) / requested_fps
      : 0.0;
  return std::abs(std::log(width_ratio)) +
      std::abs(std::log(height_ratio)) + fps_distance * 0.5;
}

CameraFormat readFormat(IMFMediaType* type) {
  CameraFormat format;
  if (!type ||
      FAILED(MFGetAttributeSize(
          type, MF_MT_FRAME_SIZE, &format.width, &format.height))) {
    return {};
  }
  if (FAILED(MFGetAttributeRatio(
          type,
          MF_MT_FRAME_RATE,
          &format.frame_rate_numerator,
          &format.frame_rate_denominator))) {
    return {};
  }
  return format;
}

std::string guidString(const GUID& guid) {
  wchar_t value[64]{};
  const int length = StringFromGUID2(guid, value, static_cast<int>(std::size(value)));
  if (length <= 1) return "unknown";
  const int size = WideCharToMultiByte(
      CP_UTF8, 0, value, length - 1, nullptr, 0, nullptr, nullptr);
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, value, length - 1, result.data(), size, nullptr, nullptr);
  return result;
}

struct NativeFormat {
  CameraFormat format;
  GUID subtype = GUID_NULL;
  ComPtr<IMFMediaType> type;
};

std::vector<NativeFormat> readNativeFormats(IMFSourceReader* reader) {
  std::vector<NativeFormat> result;
  for (DWORD index = 0;; ++index) {
    ComPtr<IMFMediaType> type;
    const auto type_result =
        reader->GetNativeMediaType(kVideoStream, index, &type);
    if (type_result == MF_E_NO_MORE_TYPES) break;
    check(type_result, "camera native format enumeration failed");
    auto format = readFormat(type.Get());
    GUID subtype = GUID_NULL;
    if (!validFormat(format) ||
        FAILED(type->GetGUID(MF_MT_SUBTYPE, &subtype))) {
      continue;
    }
    result.push_back({format, subtype, type});
  }
  return result;
}

ComPtr<IMFMediaType> makeOutputType(
    const CameraFormat& format,
    const GUID& subtype) {
  ComPtr<IMFMediaType> type;
  check(MFCreateMediaType(&type), "camera media type creation failed");
  check(
      type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video),
      "camera major type failed");
  check(type->SetGUID(MF_MT_SUBTYPE, subtype), "camera subtype failed");
  check(
      MFSetAttributeSize(
          type.Get(), MF_MT_FRAME_SIZE, format.width, format.height),
      "camera frame size failed");
  check(
      MFSetAttributeRatio(
          type.Get(),
          MF_MT_FRAME_RATE,
          format.frame_rate_numerator,
          format.frame_rate_denominator),
      "camera frame rate failed");
  check(
      type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive),
      "camera interlace mode failed");
  check(
      MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
      "camera pixel aspect ratio failed");
  if (subtype == MFVideoFormat_RGB32) {
    LONG stride = 0;
    check(
        MFGetStrideForBitmapInfoHeader(
            MFVideoFormat_RGB32.Data1, format.width, &stride),
        "camera RGB32 stride calculation failed");
    check(
        type->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(stride)),
        "camera default stride failed");
  }
  return type;
}

NativeFormat negotiateFormat(
    IMFSourceReader* reader,
    const CameraFormat& requested,
    bool gpu) {
  auto native = readNativeFormats(reader);
  std::vector<CameraFormat> formats;
  formats.reserve(native.size());
  for (const auto& candidate : native) formats.push_back(candidate.format);
  const auto ranked = rankCameraOutputFormats(requested, std::move(formats));
  HRESULT last_result = MF_E_INVALIDMEDIATYPE;
  for (const auto& candidate : ranked) {
    for (const auto& native_candidate : native) {
      if (native_candidate.format != candidate) continue;

      // A camera can advertise the same geometry through several native
      // subtypes. Try each subtype instead of letting the first MJPG/YUY2/H264
      // entry hide another mode that the source reader can actually convert.
      last_result = reader->SetCurrentMediaType(
          kVideoStream, nullptr, native_candidate.type.Get());
      if (FAILED(last_result)) continue;
      auto output = makeOutputType(
          candidate, gpu ? MFVideoFormat_NV12 : MFVideoFormat_RGB32);
      last_result =
          reader->SetCurrentMediaType(kVideoStream, nullptr, output.Get());
      if (FAILED(last_result)) continue;
      ComPtr<IMFMediaType> current;
      check(
          reader->GetCurrentMediaType(kVideoStream, &current),
          "camera negotiated format unavailable");
      const auto negotiated = readFormat(current.Get());
      if (!validFormat(negotiated) || negotiated != candidate) continue;
      return native_candidate;
    }
  }
  check(last_result, "camera format negotiation failed");
  throw std::runtime_error("camera format negotiation failed");
}

void validateBufferBounds(
    const BYTE* scanline_zero,
    LONG pitch,
    const BYTE* buffer_start,
    DWORD buffer_length,
    std::uint32_t width,
    std::uint32_t height) {
  const auto row_bytes = static_cast<std::uint64_t>(width) * 4;
  const auto begin = reinterpret_cast<std::uintptr_t>(buffer_start);
  const auto end = begin + buffer_length;
  if (end < begin) throw std::runtime_error("camera buffer bounds overflow");
  const auto first = reinterpret_cast<std::intptr_t>(scanline_zero);
  for (std::uint32_t row = 0; row < height; ++row) {
    const auto address =
        first + static_cast<std::intptr_t>(row) * pitch;
    if (address < 0) {
      throw std::runtime_error("camera row address is invalid");
    }
    const auto unsigned_address =
        static_cast<std::uintptr_t>(address);
    if (unsigned_address < begin || unsigned_address > end ||
        row_bytes > end - unsigned_address) {
      throw std::runtime_error("camera frame exceeds its media buffer");
    }
  }
}

void copySampleToBgra(
    IMFSample* sample,
    IMFMediaType* type,
    CameraFrame& frame) {
  const auto format = readFormat(type);
  if (!validFormat(format)) {
    throw std::runtime_error("camera frame dimensions unavailable");
  }
  ComPtr<IMFMediaBuffer> buffer;
  check(
      sample->ConvertToContiguousBuffer(&buffer),
      "camera buffer conversion failed");

  ComPtr<IMF2DBuffer2> buffer_2d;
  if (SUCCEEDED(buffer.As(&buffer_2d))) {
    BYTE* scanline_zero = nullptr;
    BYTE* buffer_start = nullptr;
    LONG pitch = 0;
    DWORD buffer_length = 0;
    check(
        buffer_2d->Lock2DSize(
            MF2DBuffer_LockFlags_Read,
            &scanline_zero,
            &pitch,
            &buffer_start,
            &buffer_length),
        "camera 2D buffer lock failed");
    try {
      validateBufferBounds(
          scanline_zero,
          pitch,
          buffer_start,
          buffer_length,
          format.width,
          format.height);
      frame.bgra = copyCameraBgraRows(
          scanline_zero, pitch, format.width, format.height);
    } catch (...) {
      buffer_2d->Unlock2D();
      throw;
    }
    check(buffer_2d->Unlock2D(), "camera 2D buffer unlock failed");
  } else {
    BYTE* bytes = nullptr;
    DWORD current_length = 0;
    check(
        buffer->Lock(&bytes, nullptr, &current_length),
        "camera buffer lock failed");
    try {
      UINT32 raw_stride = 0;
      LONG stride = static_cast<LONG>(checkedCameraRowBytes(format.width));
      if (SUCCEEDED(type->GetUINT32(MF_MT_DEFAULT_STRIDE, &raw_stride))) {
        stride = static_cast<LONG>(raw_stride);
      }
      frame.bgra = copyCameraBgraBuffer(
          bytes, current_length, stride, format.width, format.height);
    } catch (...) {
      buffer->Unlock();
      throw;
    }
    check(buffer->Unlock(), "camera buffer unlock failed");
  }
  frame.width = format.width;
  frame.height = format.height;
  frame.gpu = false;
}

std::wstring wide(const std::string& value) {
  if (value.empty()) return {};
  const auto size = MultiByteToWideChar(
      CP_UTF8,
      0,
      value.data(),
      static_cast<int>(value.size()),
      nullptr,
      0);
  if (size <= 0) throw std::runtime_error("camera device id is invalid UTF-8");
  std::wstring result(static_cast<std::size_t>(size), L'\0');
  MultiByteToWideChar(
      CP_UTF8,
      0,
      value.data(),
      static_cast<int>(value.size()),
      result.data(),
      size);
  return result;
}

std::string utf8(const WCHAR* value, UINT32 length) {
  if (!value || length == 0) return {};
  const auto size = WideCharToMultiByte(
      CP_UTF8,
      0,
      value,
      static_cast<int>(length),
      nullptr,
      0,
      nullptr,
      nullptr);
  if (size <= 0) throw std::runtime_error("camera device string is invalid");
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(
      CP_UTF8,
      0,
      value,
      static_cast<int>(length),
      result.data(),
      size,
      nullptr,
      nullptr);
  return result;
}

struct AsyncReaderState {
  std::mutex mutex;
  std::condition_variable changed;
  ComPtr<IMFSample> sample;
  LONGLONG timestamp_100ns = 0;
  HRESULT error = S_OK;
  DWORD flags = 0;
  bool read_in_flight = false;
  bool stopping = false;
  bool flushed = false;
  bool device_removed = false;
  std::chrono::steady_clock::time_point last_callback =
      std::chrono::steady_clock::now();
  std::wstring device_id;
};

void markDeviceRemoved(const std::shared_ptr<AsyncReaderState>& state) {
  std::lock_guard lock(state->mutex);
  state->device_removed = true;
  state->read_in_flight = false;
  state->changed.notify_all();
}

class SourceReaderCallback final
    : public RuntimeClass<
          RuntimeClassFlags<ClassicCom>,
          IMFSourceReaderCallback> {
 public:
  explicit SourceReaderCallback(std::shared_ptr<AsyncReaderState> state)
      : state_(std::move(state)) {}

  STDMETHODIMP OnReadSample(
      HRESULT status,
      DWORD,
      DWORD flags,
      LONGLONG timestamp,
      IMFSample* sample) override {
    std::lock_guard lock(state_->mutex);
    state_->read_in_flight = false;
    state_->last_callback = std::chrono::steady_clock::now();
    state_->error = status;
    state_->flags = flags;
    state_->timestamp_100ns = timestamp;
    state_->sample = sample;
    state_->changed.notify_all();
    return S_OK;
  }

  STDMETHODIMP OnEvent(DWORD, IMFMediaEvent* event) override {
    if (!event) return S_OK;
    MediaEventType type = MEUnknown;
    if (SUCCEEDED(event->GetType(&type)) &&
        type == MEVideoCaptureDeviceRemoved) {
      markDeviceRemoved(state_);
    }
    return S_OK;
  }

  STDMETHODIMP OnFlush(DWORD) override {
    std::lock_guard lock(state_->mutex);
    state_->flushed = true;
    state_->read_in_flight = false;
    state_->changed.notify_all();
    return S_OK;
  }

 private:
  std::shared_ptr<AsyncReaderState> state_;
};

class CameraGpuPool final {
 public:
  CameraGpuPool(
      ID3D11Device* device,
      ID3D11DeviceContext* context,
      std::uint64_t adapter_luid,
      std::uint32_t width,
      std::uint32_t height,
      std::shared_ptr<VideoResourceLease> resource_lease)
      : resource_lease_(std::move(resource_lease)),
        device_(device),
        context_(context),
        completion_(device, context),
        adapter_luid_(adapter_luid),
        width_(width),
        height_(height) {
    check(
        completion_.initializationResult(),
        "camera GPU completion query creation failed");
    D3D11_TEXTURE2D_DESC description{};
    description.Width = width_;
    description.Height = height_;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_NV12;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_RENDER_TARGET;
    description.MiscFlags =
        D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
        D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
    for (auto& slot : slots_) {
      check(
          device_->CreateTexture2D(&description, nullptr, &slot.texture),
          "camera shared NV12 texture creation failed");
      check(
          slot.texture.As(&slot.mutex),
          "camera shared NV12 texture has no keyed mutex");
      ComPtr<IDXGIResource1> resource;
      check(
          slot.texture.As(&resource),
          "camera shared NV12 texture has no DXGI resource");
      check(
          resource->CreateSharedHandle(
              nullptr,
              DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
              nullptr,
              &slot.handle),
          "camera shared NV12 handle creation failed");
    }
  }

  ~CameraGpuPool() {
    for (auto& slot : slots_) {
      if (slot.handle) CloseHandle(slot.handle);
    }
  }

  bool process(IMFSample* sample, std::uint64_t timestamp_us, CameraFrame& frame) {
    retryPending();
    ComPtr<IMFMediaBuffer> buffer;
    check(sample->GetBufferByIndex(0, &buffer), "camera GPU buffer unavailable");
    ComPtr<IMFDXGIBuffer> dxgi_buffer;
    check(buffer.As(&dxgi_buffer), "camera sample is not a DXGI buffer");
    ComPtr<ID3D11Texture2D> source;
    check(
        dxgi_buffer->GetResource(IID_PPV_ARGS(&source)),
        "camera DXGI texture unavailable");
    UINT subresource = 0;
    check(
        dxgi_buffer->GetSubresourceIndex(&subresource),
        "camera DXGI subresource unavailable");
    D3D11_TEXTURE2D_DESC source_description{};
    source->GetDesc(&source_description);
    if (source_description.Format != DXGI_FORMAT_NV12 ||
        source_description.Width < width_ ||
        source_description.Height < height_) {
      throw std::runtime_error(
          "camera DXGI sample does not match negotiated NV12 geometry");
    }
    const D3D11_BOX source_box{
        0,
        0,
        0,
        width_,
        height_,
        1,
    };

    for (std::size_t attempt = 0; attempt < slots_.size(); ++attempt) {
      const auto index = (next_slot_ + attempt) % slots_.size();
      auto& slot = slots_[index];
      const HRESULT acquired = slot.mutex->AcquireSync(kProducerKey, 0);
      if (acquired == WAIT_TIMEOUT) continue;
      check(acquired, "camera GPU slot acquire failed");
      const auto sequence =
          next_sequence_.fetch_add(1, std::memory_order_relaxed) + 1;
      context_->CopySubresourceRegion(
          slot.texture.Get(),
          0,
          0,
          0,
          0,
          source.Get(),
          subresource,
          &source_box);
      const HRESULT completed =
          completion_.wait(std::chrono::milliseconds(500));
      if (FAILED(completed)) {
        // The event query can cross its freshness deadline while the copy is
        // still executing. Keep the slot locked and let camera recovery retire
        // this D3D generation; exposing or reusing the texture here would race
        // the in-flight GPU command.
        check(completed, "camera GPU copy did not complete");
      }
      // Store the generation before handing key 1 to the encoder. A discard
      // for the preceding frame must never reclaim this newly published copy.
      slot.sequence.store(sequence, std::memory_order_release);
      check(
          slot.mutex->ReleaseSync(kConsumerKey),
          "camera GPU slot handoff failed");
      frame = {};
      frame.gpu = true;
      frame.width = width_;
      frame.height = height_;
      frame.sequence = sequence;
      frame.timestamp_us = timestamp_us;
      frame.slot = static_cast<std::uint32_t>(index);
      frame.shared_texture_handle =
          reinterpret_cast<std::uintptr_t>(slot.handle);
      frame.adapter_luid = adapter_luid_;
      next_slot_ = (index + 1) % slots_.size();
      return true;
    }
    return false;
  }

  void discard(const CameraFrame& frame) noexcept {
    if (!frame.gpu || frame.slot >= slots_.size() ||
        frame.adapter_luid != adapter_luid_) {
      return;
    }
    auto& slot = slots_[frame.slot];
    if (slot.sequence.load(std::memory_order_acquire) != frame.sequence ||
        reinterpret_cast<std::uintptr_t>(slot.handle) !=
            frame.shared_texture_handle) {
      return;
    }
    if (slot.mutex->AcquireSync(kConsumerKey, 0) == S_OK) {
      slot.mutex->ReleaseSync(kProducerKey);
      auto pending = frame.sequence;
      slot.pending_sequence.compare_exchange_strong(
          pending, 0, std::memory_order_acq_rel);
    } else {
      slot.pending_sequence.store(
          frame.sequence, std::memory_order_release);
    }
  }

 private:
  struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<IDXGIKeyedMutex> mutex;
    HANDLE handle = nullptr;
    std::atomic<std::uint64_t> sequence{0};
    std::atomic<std::uint64_t> pending_sequence{0};
  };

  void retryPending() noexcept {
    for (auto& slot : slots_) {
      auto pending = slot.pending_sequence.load(std::memory_order_acquire);
      if (pending == 0) continue;
      if (slot.sequence.load(std::memory_order_acquire) != pending) {
        slot.pending_sequence.compare_exchange_strong(
            pending, 0, std::memory_order_acq_rel);
        continue;
      }
      if (slot.mutex->AcquireSync(kConsumerKey, 0) != S_OK) continue;
      if (SUCCEEDED(slot.mutex->ReleaseSync(kProducerKey))) {
        slot.pending_sequence.compare_exchange_strong(
            pending, 0, std::memory_order_acq_rel);
      }
    }
  }

  std::shared_ptr<VideoResourceLease> resource_lease_;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  D3d11GpuCompletion completion_;
  std::uint64_t adapter_luid_ = 0;
  std::uint32_t width_ = 0;
  std::uint32_t height_ = 0;
  std::array<Slot, kGpuPoolSize> slots_;
  std::size_t next_slot_ = 0;
  std::atomic<std::uint64_t> next_sequence_{0};
};

class MfCameraCapture final : public CameraCapture {
 public:
  MfCameraCapture(
      const std::string& id,
      std::uint32_t width,
      std::uint32_t height,
      int fps,
      bool force_cpu,
      VideoResourceAdmissionBudget& resource_budget)
      : state_(std::make_shared<AsyncReaderState>()),
        resource_budget_(&resource_budget) {
    ActivateArray devices;
    ComPtr<IMFAttributes> attributes;
    check(MFCreateAttributes(&attributes, 1), "camera attributes creation failed");
    check(
        attributes->SetGUID(
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID),
        "camera source type failed");
    check(
        MFEnumDeviceSources(
            attributes.Get(), &devices.values, &devices.count),
        "camera enumeration failed");

    const auto wanted = wide(id);
    for (UINT32 index = 0; index < devices.count && !source_; ++index) {
      WCHAR* symbolic = nullptr;
      UINT32 length = 0;
      const HRESULT string_result =
          devices.values[index]->GetAllocatedString(
              MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
              &symbolic,
              &length);
      if (FAILED(string_result)) {
        CoTaskMemFree(symbolic);
        check(string_result, "camera symbolic link unavailable");
      }
      const bool match =
          wanted.empty() || (symbolic && wanted == symbolic);
      if (match) state_->device_id.assign(symbolic, length);
      CoTaskMemFree(symbolic);
      if (!match) continue;
      check(
          devices.values[index]->ActivateObject(IID_PPV_ARGS(&source_)),
          "camera activation failed");
    }
    if (!source_) throw std::runtime_error("camera device not found");

    try {
      if (force_cpu) {
        throw std::runtime_error("CPU camera capture was explicitly requested");
      }
      createD3dDevice();
      const auto capability =
          livekit::queryD3D11H264CapabilityForAdapter(adapter_luid_);
      info_.gpu = capability.available;
    } catch (const std::exception& error) {
      info_.gpu = false;
      dxgi_manager_.Reset();
      d3d_context_.Reset();
      d3d_device_.Reset();
      d3d_device_lease_.reset();
      diagnostics::DiagnosticLog::instance().write(
          "camera_gpu_fallback",
          {
              {"stage", "d3d_initialization"},
              {"reason", error.what()},
          });
    }
    info_.adapter_luid = info_.gpu ? adapter_luid_ : 0;

    callback_ = Make<SourceReaderCallback>(state_);
    ComPtr<IMFAttributes> reader_attributes;
    check(
        MFCreateAttributes(&reader_attributes, 6),
        "camera reader attributes creation failed");
    check(
        reader_attributes->SetUnknown(
            MF_SOURCE_READER_ASYNC_CALLBACK, callback_.Get()),
        "camera async callback setup failed");
    check(
        reader_attributes->SetUINT32(
            MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE),
        "camera advanced video processing setup failed");
    check(
        reader_attributes->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, FALSE),
        "camera converter setup failed");
    check(
        reader_attributes->SetUINT32(
            MF_SOURCE_READER_DISCONNECT_MEDIASOURCE_ON_SHUTDOWN, TRUE),
        "camera source shutdown setup failed");
    if (info_.gpu) {
      check(
          reader_attributes->SetUnknown(
              MF_SOURCE_READER_D3D_MANAGER, dxgi_manager_.Get()),
          "camera D3D manager setup failed");
    }
    check(
        MFCreateSourceReaderFromMediaSource(
            source_.Get(), reader_attributes.Get(), &reader_),
        "camera reader creation failed");

    const CameraFormat requested{
        width,
        height,
        static_cast<std::uint32_t>(fps),
        1};
    NativeFormat selected;
    if (info_.gpu) {
      try {
        selected = negotiateFormat(reader_.Get(), requested, true);
        auto pool_lease = acquireCameraResource(
            *resource_budget_,
            VideoResourceRequest{
                .owner = VideoResourceOwner::CameraCapture,
                .owner_id = "camera:capture_pool",
                .gpu_generations = 1,
                .textures = {{
                    .width = selected.format.width,
                    .height = selected.format.height,
                    .count = kGpuPoolSize,
                    .format = VideoTextureFormat::Nv12,
                }},
            });
        gpu_pool_ = std::make_unique<CameraGpuPool>(
            d3d_device_.Get(),
            d3d_context_.Get(),
            adapter_luid_,
            selected.format.width,
            selected.format.height,
            std::move(pool_lease));
      } catch (const std::exception& error) {
        diagnostics::DiagnosticLog::instance().write(
            "camera_gpu_fallback",
            {
                {"stage", "nv12_negotiation"},
                {"reason", error.what()},
            });
        info_.gpu = false;
        info_.adapter_luid = 0;
        gpu_pool_.reset();
        selected = negotiateFormat(reader_.Get(), requested, false);
      }
    } else {
      selected = negotiateFormat(reader_.Get(), requested, false);
    }
    info_.format = selected.format;
    info_.native_subtype = guidString(selected.subtype);
    info_.output_subtype =
        guidString(info_.gpu ? MFVideoFormat_NV12 : MFVideoFormat_RGB32);
    registerDeviceNotification();
    diagnostics::DiagnosticLog::instance().write(
        "camera_format_negotiated",
        {
            {"width", static_cast<std::uint64_t>(info_.format.width)},
            {"height", static_cast<std::uint64_t>(info_.format.height)},
            {"fps", framesPerSecond(info_.format)},
            {"nativeSubtype", info_.native_subtype},
            {"outputSubtype", info_.output_subtype},
            {"gpu", info_.gpu},
        });
    requestSample();
  }

  ~MfCameraCapture() override { stop(); }

  bool read(CameraFrame& frame, const std::atomic_bool& running) override {
    for (;;) {
      if (!running.load(std::memory_order_acquire)) return false;
      ComPtr<IMFSample> sample;
      LONGLONG timestamp = 0;
      {
        std::unique_lock lock(state_->mutex);
        state_->changed.wait_for(lock, kReadPoll, [&] {
          return state_->stopping || state_->device_removed ||
              FAILED(state_->error) || state_->sample ||
              !state_->read_in_flight ||
              (state_->flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0;
        });
        if (state_->stopping ||
            !running.load(std::memory_order_acquire)) {
          return false;
        }
        if (state_->device_removed) {
          throw CameraCaptureError(
              "device_removed", "Camera device was removed");
        }
        if (FAILED(state_->error)) {
          if (state_->error == MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED) {
            throw CameraCaptureError(
                "device_removed", "Camera device was invalidated");
          }
          check(state_->error, "camera async sample failed");
        }
        if ((state_->flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) {
          throw CameraCaptureError(
              "device_removed", "Camera stream ended");
        }
        sample = std::move(state_->sample);
        timestamp = state_->timestamp_100ns;
        state_->flags = 0;
        state_->error = S_OK;
        if (!sample &&
            std::chrono::steady_clock::now() - state_->last_callback >=
                kFrameWatchdog) {
          lock.unlock();
          stop();
          throw CameraCaptureError(
              "camera_capture_timeout",
              "Camera stopped delivering asynchronous samples");
        }
      }
      if (!sample) {
        // STREAMTICK and other sample-less callbacks still complete the
        // outstanding async read. Queue the next request instead of waiting
        // until the watchdog misclassifies a healthy sparse stream as stalled.
        requestSample();
        continue;
      }

      if (info_.gpu) {
        if (!gpu_pool_->process(
                sample.Get(),
                timestamp > 0
                    ? static_cast<std::uint64_t>(timestamp / 10)
                    : 0,
                frame)) {
          requestSample();
          continue;
        }
      } else {
        ComPtr<IMFMediaType> type;
        check(
            reader_->GetCurrentMediaType(kVideoStream, &type),
            "camera media type unavailable");
        copySampleToBgra(sample.Get(), type.Get(), frame);
        frame.timestamp_us =
            timestamp > 0 ? static_cast<std::uint64_t>(timestamp / 10) : 0;
      }
      requestSample();
      return true;
    }
  }

  void stop() noexcept override {
    if (stopped_.exchange(true, std::memory_order_acq_rel)) return;
    if (device_notification_) {
      const auto outcome = device_notification_->stop(
          std::chrono::steady_clock::now() + kFlushDeadline);
      const auto global = CameraDeviceNotification::globalSnapshot();
      const char* status = "not_registered";
      if (outcome.status ==
          CameraDeviceNotificationStopStatus::Unregistered) {
        status = "unregistered";
      } else if (outcome.status ==
          CameraDeviceNotificationStopStatus::
              UnregisterFailedQuarantined) {
        status = "unregister_failed_quarantined";
      } else if (outcome.status ==
          CameraDeviceNotificationStopStatus::DrainTimedOutQuarantined) {
        status = "drain_timed_out_quarantined";
      }
      diagnostics::DiagnosticLog::instance().write(
          "camera_device_notification_stop",
          {
              {"status", status},
              {"nativeCode", static_cast<std::uint64_t>(outcome.native_code)},
              {"unfinishedCallbacks",
               static_cast<std::uint64_t>(outcome.unfinished_callbacks)},
              {"ownedContexts",
               static_cast<std::uint64_t>(global.owned_contexts)},
              {"quarantinedContexts",
               static_cast<std::uint64_t>(global.quarantined_contexts)},
          });
      device_notification_.reset();
    }
    {
      std::lock_guard lock(state_->mutex);
      state_->stopping = true;
      state_->changed.notify_all();
    }
    if (reader_) {
      const HRESULT flush_result =
          reader_->Flush(
              static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS));
      if (SUCCEEDED(flush_result)) {
        std::unique_lock lock(state_->mutex);
        state_->changed.wait_for(
            lock, kFlushDeadline, [&] { return state_->flushed; });
      }
    }
    if (source_) source_->Shutdown();
    // read() can still be unwinding on the capture thread. Keep the COM and
    // D3D members alive until the shared CameraCapture itself is destroyed;
    // resetting them here races requestSample(), GetCurrentMediaType(), and
    // GPU sample processing.
  }

  CameraCaptureInfo info() const override { return info_; }

  void discard(const CameraFrame& frame) noexcept override {
    if (gpu_pool_) gpu_pool_->discard(frame);
  }

 private:
  void createD3dDevice() {
    d3d_device_lease_ = acquireCameraResource(
        *resource_budget_,
        VideoResourceRequest{
            .owner = VideoResourceOwner::CameraCapture,
            .owner_id = "camera:capture_device",
            .d3d_devices = 1,
            .gpu_generations = 1,
        });
    UINT flags =
        D3D11_CREATE_DEVICE_BGRA_SUPPORT |
        D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    D3D_FEATURE_LEVEL feature = D3D_FEATURE_LEVEL_11_0;
    check(
        D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            flags,
            nullptr,
            0,
            D3D11_SDK_VERSION,
            &d3d_device_,
            &feature,
            &d3d_context_),
        "camera D3D11 device creation failed");
    ComPtr<ID3D10Multithread> multithread;
    check(
        d3d_device_.As(&multithread),
        "camera D3D11 multithread interface unavailable");
    multithread->SetMultithreadProtected(TRUE);
    ComPtr<IDXGIDevice> dxgi_device;
    ComPtr<IDXGIAdapter> adapter;
    DXGI_ADAPTER_DESC description{};
    check(
        d3d_device_.As(&dxgi_device),
        "camera DXGI device unavailable");
    check(
        dxgi_device->GetAdapter(&adapter),
        "camera DXGI adapter unavailable");
    check(
        adapter->GetDesc(&description),
        "camera DXGI adapter description unavailable");
    adapter_luid_ =
        static_cast<std::uint64_t>(description.AdapterLuid.LowPart) |
        (static_cast<std::uint64_t>(
             static_cast<std::uint32_t>(description.AdapterLuid.HighPart))
         << 32U);
    UINT token = 0;
    check(
        MFCreateDXGIDeviceManager(&token, &dxgi_manager_),
        "camera DXGI manager creation failed");
    check(
        dxgi_manager_->ResetDevice(d3d_device_.Get(), token),
        "camera DXGI manager device reset failed");
  }

  void requestSample() {
    {
      std::lock_guard lock(state_->mutex);
      if (state_->stopping || state_->read_in_flight) return;
      state_->read_in_flight = true;
    }
    const HRESULT result =
        reader_->ReadSample(kVideoStream, 0, nullptr, nullptr, nullptr, nullptr);
    if (FAILED(result)) {
      std::lock_guard lock(state_->mutex);
      state_->read_in_flight = false;
      state_->error = result;
      state_->changed.notify_all();
    }
  }

  void registerDeviceNotification() {
    device_notification_ = std::make_unique<CameraDeviceNotification>(
        createWindowsCameraDeviceNotificationAdapter(),
        state_->device_id,
        [state = state_](CameraDeviceNotificationAction action) {
          if (action == CameraDeviceNotificationAction::Removal) {
            markDeviceRemoved(state);
          }
        });
    const auto outcome = device_notification_->start();
    if (outcome.status == CameraDeviceNotificationStartStatus::Registered) {
      return;
    }
    const auto global = CameraDeviceNotification::globalSnapshot();
    const char* status = outcome.status ==
            CameraDeviceNotificationStartStatus::OwnershipUnavailable
        ? "ownership_unavailable"
        : (outcome.status ==
                   CameraDeviceNotificationStartStatus::AlreadyStarted
               ? "already_started"
               : "registration_failed");
    diagnostics::DiagnosticLog::instance().write(
        "camera_device_notification_start_failed",
        {
            {"status", status},
            {"nativeCode", static_cast<std::uint64_t>(outcome.native_code)},
            {"ownedContexts",
             static_cast<std::uint64_t>(global.owned_contexts)},
            {"quarantinedContexts",
             static_cast<std::uint64_t>(global.quarantined_contexts)},
            {"ownershipRejections", global.ownership_rejections},
        });
    device_notification_.reset();
  }

  std::shared_ptr<AsyncReaderState> state_;
  VideoResourceAdmissionBudget* resource_budget_ = nullptr;
  std::shared_ptr<VideoResourceLease> d3d_device_lease_;
  std::unique_ptr<CameraDeviceNotification> device_notification_;
  ComPtr<IMFMediaSource> source_;
  ComPtr<IMFSourceReader> reader_;
  ComPtr<SourceReaderCallback> callback_;
  ComPtr<ID3D11Device> d3d_device_;
  ComPtr<ID3D11DeviceContext> d3d_context_;
  ComPtr<IMFDXGIDeviceManager> dxgi_manager_;
  std::unique_ptr<CameraGpuPool> gpu_pool_;
  CameraCaptureInfo info_;
  std::uint64_t adapter_luid_ = 0;
  std::atomic_bool stopped_{false};
};

class MfCameraCaptureFactory final : public CameraCaptureFactory {
 public:
  explicit MfCameraCaptureFactory(
      VideoResourceAdmissionBudget& resource_budget)
      : resource_budget_(&resource_budget) {}

  std::shared_ptr<CameraCapture> create(
      const std::string& id,
      std::uint32_t width,
      std::uint32_t height,
      int fps,
      bool force_cpu) override {
    check(MFStartup(MF_VERSION, MFSTARTUP_LITE), "Media Foundation startup failed");
    try {
      return std::shared_ptr<CameraCapture>(
          new MfCameraCapture(
              id, width, height, fps, force_cpu, *resource_budget_),
          [](CameraCapture* capture) {
            delete capture;
            MFShutdown();
          });
    } catch (...) {
      MFShutdown();
      throw;
    }
  }

 private:
  VideoResourceAdmissionBudget* resource_budget_ = nullptr;
};

}  // namespace

std::vector<CameraFormat> rankCameraOutputFormats(
    CameraFormat requested,
    std::vector<CameraFormat> native_formats) {
  if (!validFormat(requested)) {
    throw std::invalid_argument("requested camera format is invalid");
  }
  native_formats.erase(
      std::remove_if(
          native_formats.begin(),
          native_formats.end(),
          [](const auto& format) { return !validFormat(format); }),
      native_formats.end());
  std::stable_sort(
      native_formats.begin(),
      native_formats.end(),
      [&](const auto& left, const auto& right) {
        return formatDistance(left, requested) <
            formatDistance(right, requested);
      });
  native_formats.erase(
      std::unique(native_formats.begin(), native_formats.end()),
      native_formats.end());
  return native_formats;
}

std::vector<std::uint8_t> copyCameraBgraRows(
    const std::uint8_t* scanline_zero,
    std::ptrdiff_t stride,
    std::uint32_t width,
    std::uint32_t height) {
  if (!scanline_zero || width == 0 || height == 0) {
    throw std::invalid_argument("camera frame geometry is invalid");
  }
  const auto row_bytes = checkedCameraRowBytes(width);
  if (height > std::numeric_limits<std::size_t>::max() / row_bytes) {
    throw std::overflow_error("camera frame size overflow");
  }
  if (checkedAbsoluteStride(stride) < row_bytes) {
    throw std::invalid_argument("camera frame stride is too small");
  }

  std::vector<std::uint8_t> result(row_bytes * height);
  for (std::uint32_t row = 0; row < height; ++row) {
    std::memcpy(
        result.data() + static_cast<std::size_t>(row) * row_bytes,
        scanline_zero + static_cast<std::ptrdiff_t>(row) * stride,
        row_bytes);
  }
  return result;
}

std::vector<std::uint8_t> copyCameraBgraBuffer(
    const std::uint8_t* buffer,
    std::size_t buffer_length,
    std::ptrdiff_t stride,
    std::uint32_t width,
    std::uint32_t height) {
  if (!buffer) {
    throw std::invalid_argument("camera frame buffer is null");
  }
  const auto row_bytes = checkedCameraRowBytes(width);
  const auto absolute_stride = checkedAbsoluteStride(stride);
  const auto required_length =
      checkedCameraFrameBytes(absolute_stride, row_bytes, height);
  if (required_length > buffer_length) {
    throw std::runtime_error("camera frame exceeds its media buffer");
  }
  const auto* scanline_zero = stride < 0
      ? buffer + absolute_stride * static_cast<std::size_t>(height - 1)
      : buffer;
  return copyCameraBgraRows(
      scanline_zero, stride, width, height);
}

std::shared_ptr<CameraCaptureFactory>
createMediaFoundationCameraCaptureFactory(
    VideoResourceAdmissionBudget* resource_budget) {
  auto& budget = resource_budget
      ? *resource_budget
      : processVideoResourceAdmissionBudget();
  return std::make_shared<MfCameraCaptureFactory>(budget);
}

std::vector<DeviceInfo> listCameraDevices() {
  check(MFStartup(MF_VERSION, MFSTARTUP_LITE), "Media Foundation startup failed");
  struct Shutdown {
    ~Shutdown() { MFShutdown(); }
  } shutdown;
  ComPtr<IMFAttributes> attributes;
  check(MFCreateAttributes(&attributes, 1), "camera attributes creation failed");
  check(
      attributes->SetGUID(
          MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
          MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID),
      "camera source type failed");
  ActivateArray devices;
  check(
      MFEnumDeviceSources(
          attributes.Get(), &devices.values, &devices.count),
      "camera enumeration failed");
  std::vector<DeviceInfo> result;
  for (UINT32 index = 0; index < devices.count; ++index) {
    WCHAR* id = nullptr;
    UINT32 id_length = 0;
    WCHAR* name = nullptr;
    UINT32 name_length = 0;
    const HRESULT id_result =
        devices.values[index]->GetAllocatedString(
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
            &id,
            &id_length);
    const HRESULT name_result =
        devices.values[index]->GetAllocatedString(
            MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
            &name,
            &name_length);
    if (FAILED(id_result) || FAILED(name_result)) {
      CoTaskMemFree(id);
      CoTaskMemFree(name);
      fail(
          FAILED(id_result) ? id_result : name_result,
          "camera device metadata unavailable");
    }
    result.push_back(DeviceInfo{
        utf8(id, id_length),
        utf8(name, name_length),
        "videoinput",
        index == 0,
    });
    CoTaskMemFree(id);
    CoTaskMemFree(name);
  }
  return result;
}

}  // namespace syrnike::desktop_native::media
