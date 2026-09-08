#include "camera/camera_capture.hpp"

#include <windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl.h>

#include <algorithm>
#include <array>
#include <limits>
#include <stdexcept>

namespace syrnike::windows_media::camera {
namespace {
using Clock = std::chrono::steady_clock;
using Microsoft::WRL::ComPtr;
constexpr DWORD kVideoStream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM);
constexpr DWORD kAllStreams = static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS);
std::int64_t timestamp() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
CameraFailure failureFor(HRESULT result) noexcept {
  if (result == MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED || result == HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED))
    return CameraFailure::device_removed;
  if (result == E_ACCESSDENIED || result == MF_E_VIDEO_RECORDING_DEVICE_PREEMPTED) return CameraFailure::unavailable;
  return CameraFailure::source_error;
}
struct CompletionState {
  HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::atomic_flag busy = ATOMIC_FLAG_INIT;
  std::atomic_bool closed{false}, flushed{false}, callback_destroyed{false};
  std::atomic<HRESULT> failure{S_OK};
  ComPtr<IMFSample> sample;
  bool completed = false;
  DWORD flags = 0;
  std::int64_t received = 0;
  CompletionState() { if (!event) throw std::runtime_error("Camera reader event creation failed"); }
  ~CompletionState() { CloseHandle(event); }
};
class ReaderCallback final : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IMFSourceReaderCallback, Microsoft::WRL::FtmBase> {
 public:
  explicit ReaderCallback(std::shared_ptr<CompletionState> state) : state_(std::move(state)) {}
  ~ReaderCallback() override { state_->callback_destroyed.store(true, std::memory_order_release); }
  STDMETHODIMP OnReadSample(HRESULT status, DWORD, DWORD flags, LONGLONG, IMFSample* sample) override {
    const auto received = timestamp();
    if (state_->closed.load(std::memory_order_acquire)) return S_OK;
    if (FAILED(status)) {
      state_->failure = status;
    } else if (state_->busy.test_and_set(std::memory_order_acquire)) {
      state_->failure = E_UNEXPECTED;
    } else {
      // Only one request is outstanding. Replacing an unconsumed completion
      // would hide a protocol/lifetime violation, so fail this camera path.
      if (state_->completed) state_->failure = E_UNEXPECTED;
      else {
        state_->sample = sample;
        state_->flags = flags;
        state_->received = received;
        state_->completed = true;
      }
      state_->busy.clear(std::memory_order_release);
    }
    SetEvent(state_->event);
    return S_OK;
  }
  STDMETHODIMP OnFlush(DWORD) override {
    state_->flushed.store(true, std::memory_order_release);
    SetEvent(state_->event);
    return S_OK;
  }
  STDMETHODIMP OnEvent(DWORD, IMFMediaEvent* event) override {
    HRESULT status = S_OK;
    if (event && SUCCEEDED(event->GetStatus(&status)) && FAILED(status)) {
      state_->failure = status;
      SetEvent(state_->event);
    }
    return S_OK;
  }
 private:
  std::shared_ptr<CompletionState> state_;
};
class MfSample final : public CameraSample {
 public:
  MfSample(ComPtr<IMFSample> sample, CameraProfile profile, std::int32_t stride, CameraPixelFormat format,
           CameraColorMatrix matrix)
      : sample_(std::move(sample)), profile_(profile), stride_(stride), format_(format), matrix_(matrix) {}
  bool copyBgra(std::span<std::uint8_t> output) override {
    DWORD count = 0, length = 0;
    if (FAILED(sample_->GetBufferCount(&count)) || !count || count > 8 ||
        FAILED(sample_->GetTotalLength(&length)) || length > kMaximumCameraBytes * 2) return false;
    ComPtr<IMFMediaBuffer> buffer;
    if (FAILED(sample_->ConvertToContiguousBuffer(&buffer))) return false;
    ComPtr<IMF2DBuffer2> planar;
    if (SUCCEEDED(buffer.As(&planar))) {
      BYTE* row_zero = nullptr;
      BYTE* start = nullptr;
      LONG pitch = 0;
      DWORD size = 0;
      if (FAILED(planar->Lock2DSize(MF2DBuffer_LockFlags_Read, &row_zero, &pitch, &start, &size))) return false;
      const auto begin_address = reinterpret_cast<std::uintptr_t>(start);
      const auto row_address = reinterpret_cast<std::uintptr_t>(row_zero);
      const bool inside = row_address >= begin_address && row_address - begin_address <= size;
      const bool copied = inside && convertCameraToBgra({std::span<const std::uint8_t>(start, size),
          profile_.width, profile_.height, static_cast<std::size_t>(row_address - begin_address), pitch, format_, matrix_}, output);
      const auto unlocked = planar->Unlock2D();
      return copied && SUCCEEDED(unlocked);
    }
    BYTE* bytes = nullptr;
    DWORD capacity = 0, used = 0;
    if (FAILED(buffer->Lock(&bytes, &capacity, &used))) return false;
    const auto offset = stride_ < 0 ? static_cast<std::uint64_t>(-static_cast<std::int64_t>(stride_)) * (profile_.height - 1) : 0;
    const bool copied = used <= capacity && offset <= used && convertCameraToBgra({std::span<const std::uint8_t>(bytes, used),
        profile_.width, profile_.height, static_cast<std::size_t>(offset), stride_, format_, matrix_}, output);
    const auto unlocked = buffer->Unlock();
    return copied && SUCCEEDED(unlocked);
  }
 private:
  ComPtr<IMFSample> sample_;
  CameraProfile profile_;
  std::int32_t stride_;
  CameraPixelFormat format_;
  CameraColorMatrix matrix_;
};
class MediaFoundationReader final : public CameraReader {
 public:
  MediaFoundationReader() {
    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) throw std::runtime_error("Camera reader requires MTA");
    if (FAILED(MFStartup(MF_VERSION))) { CoUninitialize(); throw std::runtime_error("Media Foundation unavailable"); }
  }
  ~MediaFoundationReader() override {
    if (!closed_) (void)close(Clock::now() + std::chrono::seconds{1});
    MFShutdown();
    CoUninitialize();
  }
  CameraOpenResult open(const CameraEndpoint& endpoint, CameraProfile requested, bool allow_downgrade) override {
    CameraOpenResult result;
    const auto failed = [&](HRESULT error, CameraFailure failure = CameraFailure::source_error) {
      result.failure = failure == CameraFailure::source_error ? failureFor(error) : failure;
      result.platform_error = error;
      return result;
    };
    if (source_ || reader_ || closed_ || !validCameraProfile(requested)) return failed(E_INVALIDARG, CameraFailure::invalid_state);
    ComPtr<IMFAttributes> attributes;
    auto status = MFCreateAttributes(&attributes, 2);
    if (SUCCEEDED(status)) status = attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
    if (SUCCEEDED(status)) status = attributes->SetString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, endpoint.symbolic_link.c_str());
    if (SUCCEEDED(status)) status = MFCreateDeviceSource(attributes.Get(), &source_);
    if (FAILED(status)) return failed(status);
    callback_ = Microsoft::WRL::Make<ReaderCallback>(state_);
    if (!callback_) return failed(E_OUTOFMEMORY);
    attributes.Reset();
    status = MFCreateAttributes(&attributes, 3);
    if (SUCCEEDED(status)) status = attributes->SetUnknown(MF_SOURCE_READER_ASYNC_CALLBACK, static_cast<IMFSourceReaderCallback*>(callback_.Get()));
    if (SUCCEEDED(status)) status = attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
    if (SUCCEEDED(status)) status = attributes->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, FALSE);
    if (SUCCEEDED(status)) status = MFCreateSourceReaderFromMediaSource(source_.Get(), attributes.Get(), &reader_);
    if (FAILED(status)) return failed(status);
    status = reader_->SetStreamSelection(kAllStreams, FALSE);
    if (SUCCEEDED(status)) status = reader_->SetStreamSelection(kVideoStream, TRUE);
    if (FAILED(status)) return failed(status);
    ComPtr<IMFMediaType> selected;
    CameraProfile selected_profile{};
    std::uint64_t selected_score = 0;
    for (DWORD index = 0; index < 256; ++index) {
      ComPtr<IMFMediaType> type;
      status = reader_->GetNativeMediaType(kVideoStream, index, &type);
      if (status == MF_E_NO_MORE_TYPES) break;
      if (FAILED(status)) return failed(status);
      UINT32 width = 0, height = 0, numerator = 0, denominator = 0;
      GUID subtype{};
      if (FAILED(MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &width, &height)) ||
          FAILED(MFGetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, &numerator, &denominator)) || !denominator ||
          FAILED(type->GetGUID(MF_MT_SUBTYPE, &subtype)) || !cameraBgraBytes(width, height)) continue;
      if (subtype != MFVideoFormat_NV12 && subtype != MFVideoFormat_YUY2 && subtype != MFVideoFormat_MJPG && subtype != MFVideoFormat_RGB32) continue;
      const auto fps = static_cast<UINT32>((static_cast<std::uint64_t>(numerator) + denominator / 2) / denominator);
      const auto nominal = static_cast<std::uint64_t>(fps) * denominator;
      const auto difference = nominal > numerator ? nominal - numerator : numerator - nominal;
      if (!fps || fps > requested.fps || difference * 10 > denominator || width > requested.width || height > requested.height) continue;
      const bool exact = width == requested.width && height == requested.height && fps == requested.fps;
      if (!exact && !allow_downgrade) continue;
      const auto score = static_cast<std::uint64_t>(width) * height * 100 + fps;
      if (!selected || score > selected_score) { selected = type; selected_profile = {width, height, fps}; selected_score = score; }
    }
    if (!selected) return failed(MF_E_INVALIDMEDIATYPE, CameraFailure::unsupported_profile);
    status = reader_->SetCurrentMediaType(kVideoStream, nullptr, selected.Get());
    if (FAILED(status)) return failed(status, CameraFailure::unsupported_format);
    const std::array formats{MFVideoFormat_RGB32, MFVideoFormat_NV12, MFVideoFormat_YUY2};
    bool negotiated = false;
    for (const auto& format : formats) {
      ComPtr<IMFMediaType> type;
      status = MFCreateMediaType(&type);
      if (SUCCEEDED(status)) status = type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
      if (SUCCEEDED(status)) status = type->SetGUID(MF_MT_SUBTYPE, format);
      if (SUCCEEDED(status)) status = reader_->SetCurrentMediaType(kVideoStream, nullptr, type.Get());
      if (SUCCEEDED(status)) { negotiated = true; break; }
    }
    if (!negotiated) return failed(status, CameraFailure::unsupported_format);
    ComPtr<IMFMediaType> current;
    status = reader_->GetCurrentMediaType(kVideoStream, &current);
    if (FAILED(status)) return failed(status);
    UINT32 width = 0, height = 0, stride = 0, matrix = MFVideoTransferMatrix_BT709;
    GUID subtype{};
    if (FAILED(MFGetAttributeSize(current.Get(), MF_MT_FRAME_SIZE, &width, &height)) ||
        FAILED(current->GetGUID(MF_MT_SUBTYPE, &subtype)) || width != selected_profile.width || height != selected_profile.height)
      return failed(MF_E_INVALIDMEDIATYPE, CameraFailure::unsupported_format);
    if (subtype != MFVideoFormat_RGB32 && subtype != MFVideoFormat_NV12 && subtype != MFVideoFormat_YUY2)
      return failed(MF_E_INVALIDMEDIATYPE, CameraFailure::unsupported_format);
    UINT32 rate_numerator = 0, rate_denominator = 0;
    if (FAILED(MFGetAttributeRatio(current.Get(), MF_MT_FRAME_RATE, &rate_numerator, &rate_denominator)) || !rate_denominator ||
        (static_cast<std::uint64_t>(rate_numerator) + rate_denominator / 2) / rate_denominator != selected_profile.fps)
      return failed(MF_E_INVALIDMEDIATYPE, CameraFailure::unsupported_profile);
    format_ = subtype == MFVideoFormat_RGB32 ? CameraPixelFormat::bgra : subtype == MFVideoFormat_NV12 ? CameraPixelFormat::nv12 : CameraPixelFormat::yuy2;
    if (FAILED(current->GetUINT32(MF_MT_DEFAULT_STRIDE, &stride))) {
      LONG default_stride = 0;
      if (FAILED(MFGetStrideForBitmapInfoHeader(subtype.Data1, width, &default_stride)))
        return failed(MF_E_INVALIDMEDIATYPE, CameraFailure::unsupported_format);
      stride = static_cast<UINT32>(default_stride);
    }
    stride_ = static_cast<std::int32_t>(stride);
    (void)current->GetUINT32(MF_MT_YUV_MATRIX, &matrix);
    matrix_ = matrix == MFVideoTransferMatrix_BT601 ? CameraColorMatrix::bt601 : CameraColorMatrix::bt709;
    profile_ = selected_profile;
    result.actual = profile_;
    result.downgraded = profile_ != requested;
    return result;
  }
  void* eventHandle() const noexcept override { return state_->event; }
  CameraFailure requestSample() override {
    if (!reader_ || pending_ || state_->closed) return CameraFailure::invalid_state;
    const auto status = reader_->ReadSample(kVideoStream, 0, nullptr, nullptr, nullptr, nullptr);
    if (FAILED(status)) return failureFor(status);
    pending_ = true;
    return CameraFailure::none;
  }
  std::optional<CameraReadEvent> takeCompleted() override {
    const auto failure = state_->failure.exchange(S_OK);
    if (FAILED(failure)) return CameraReadEvent{failureFor(failure), failure, 0, {}};
    if (state_->busy.test_and_set(std::memory_order_acquire)) return {};
    if (!state_->completed) { ResetEvent(state_->event); state_->busy.clear(std::memory_order_release); return {}; }
    ComPtr<IMFSample> sample = std::move(state_->sample);
    const auto flags = state_->flags;
    const auto received = state_->received;
    state_->completed = false;
    pending_ = false;
    ResetEvent(state_->event);
    state_->busy.clear(std::memory_order_release);
    if (flags & (MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED | MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED))
      return CameraReadEvent{CameraFailure::format_changed, 0, received, {}};
    if (flags & (MF_SOURCE_READERF_ERROR | MF_SOURCE_READERF_ENDOFSTREAM))
      return CameraReadEvent{CameraFailure::source_error, 0, received, {}};
    CameraReadEvent result{CameraFailure::none, 0, received, {}};
    if (sample) result.sample = std::make_unique<MfSample>(std::move(sample), profile_, stride_, format_, matrix_);
    return result;
  }
  bool close(Clock::time_point deadline) noexcept override {
    if (closed_) return close_succeeded_;
    closed_ = true;
    state_->closed = true;
    bool flushed = true;
    if (reader_ && pending_) {
      ResetEvent(state_->event);
      const auto status = reader_->Flush(kAllStreams);
      flushed = SUCCEEDED(status);
      while (flushed && !state_->flushed.load(std::memory_order_acquire) && Clock::now() < deadline) {
        (void)WaitForSingleObject(state_->event, 10);
        ResetEvent(state_->event);
      }
      flushed = flushed && state_->flushed.load(std::memory_order_acquire);
    }
    reader_.Reset();
    if (source_) {
      const auto status = source_->Shutdown();
      // Source Reader may already have shut down its media source on release.
      flushed = flushed && (SUCCEEDED(status) || status == MF_E_SHUTDOWN);
    }
    source_.Reset();
    const bool had_callback = static_cast<bool>(callback_);
    callback_.Reset();
    while (had_callback && !state_->callback_destroyed.load(std::memory_order_acquire) && Clock::now() < deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds{1});
    close_succeeded_ = flushed && (!had_callback || state_->callback_destroyed.load(std::memory_order_acquire));
    if (!had_callback || state_->callback_destroyed.load(std::memory_order_acquire)) state_->sample.Reset();
    return close_succeeded_;
  }
 private:
  std::shared_ptr<CompletionState> state_ = std::make_shared<CompletionState>();
  ComPtr<IMFMediaSource> source_;
  ComPtr<IMFSourceReader> reader_;
  ComPtr<ReaderCallback> callback_;
  CameraProfile profile_;
  CameraPixelFormat format_ = CameraPixelFormat::bgra;
  CameraColorMatrix matrix_ = CameraColorMatrix::bt709;
  std::int32_t stride_ = 0;
  bool pending_ = false, closed_ = false, close_succeeded_ = false;
};
}  // namespace
std::unique_ptr<CameraReader> makeMediaFoundationCameraReader() { return std::make_unique<MediaFoundationReader>(); }
}  // namespace syrnike::windows_media::camera
