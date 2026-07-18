#include "camera_capture.hpp"

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>

namespace syrnike::desktop_native::media {
namespace {
using Microsoft::WRL::ComPtr;
constexpr DWORD video_stream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM);

void check(HRESULT result, const char* message) {
  if (SUCCEEDED(result)) return;
  std::ostringstream output;
  output << message << " (HRESULT=0x" << std::hex << std::setw(8)
         << std::setfill('0') << static_cast<std::uint32_t>(result) << ')';
  throw std::runtime_error(output.str());
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
    format.frame_rate_numerator > 0 && format.frame_rate_denominator > 0;
}

double formatDistance(const CameraFormat& candidate, const CameraFormat& requested) {
  const auto width_ratio = static_cast<double>(candidate.width) / requested.width;
  const auto height_ratio = static_cast<double>(candidate.height) / requested.height;
  const auto requested_fps = framesPerSecond(requested);
  const auto fps_distance = requested_fps > 0.0
    ? std::abs(framesPerSecond(candidate) - requested_fps) / requested_fps
    : 0.0;
  return std::abs(std::log(width_ratio)) + std::abs(std::log(height_ratio)) +
    fps_distance * 0.5;
}

CameraFormat readFormat(IMFMediaType* type) {
  CameraFormat format;
  if (FAILED(MFGetAttributeSize(
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

std::vector<CameraFormat> readNativeFormats(IMFSourceReader* reader) {
  std::vector<CameraFormat> result;
  for (DWORD index = 0;; ++index) {
    ComPtr<IMFMediaType> type;
    const auto type_result = reader->GetNativeMediaType(video_stream, index, &type);
    if (type_result == MF_E_NO_MORE_TYPES) break;
    check(type_result, "camera native format enumeration failed");
    auto format = readFormat(type.Get());
    if (validFormat(format)) result.push_back(format);
  }
  return result;
}

ComPtr<IMFMediaType> makeRgb32Type(const CameraFormat& format) {
  ComPtr<IMFMediaType> type;
  check(MFCreateMediaType(&type), "camera media type creation failed");
  check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "camera major type failed");
  check(type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32), "camera RGB32 type failed");
  check(MFSetAttributeSize(
        type.Get(), MF_MT_FRAME_SIZE, format.width, format.height),
    "camera frame size failed");
  check(MFSetAttributeRatio(
        type.Get(),
        MF_MT_FRAME_RATE,
        format.frame_rate_numerator,
        format.frame_rate_denominator),
    "camera frame rate failed");
  check(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive),
    "camera interlace mode failed");
  check(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
    "camera pixel aspect ratio failed");
  return type;
}

CameraFormat negotiateRgb32Format(
  IMFSourceReader* reader,
  const CameraFormat& requested
) {
  auto candidates = rankCameraOutputFormats(requested, readNativeFormats(reader));
  HRESULT last_result = MF_E_INVALIDMEDIATYPE;
  for (const auto& candidate : candidates) {
    auto type = makeRgb32Type(candidate);
    last_result = reader->SetCurrentMediaType(video_stream, nullptr, type.Get());
    if (SUCCEEDED(last_result)) {
      ComPtr<IMFMediaType> current;
      check(reader->GetCurrentMediaType(video_stream, &current),
        "camera negotiated format unavailable");
      const auto negotiated = readFormat(current.Get());
      if (!validFormat(negotiated)) {
        throw std::runtime_error("camera negotiated format is incomplete");
      }
      return negotiated;
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
  std::uint32_t height
) {
  const auto row_bytes = static_cast<std::uint64_t>(width) * 4;
  const auto begin = reinterpret_cast<std::uintptr_t>(buffer_start);
  const auto end = begin + buffer_length;
  if (end < begin) throw std::runtime_error("camera buffer bounds overflow");
  const auto first = reinterpret_cast<std::intptr_t>(scanline_zero);
  for (std::uint32_t row = 0; row < height; ++row) {
    const auto address = first + static_cast<std::intptr_t>(row) * pitch;
    if (address < 0) throw std::runtime_error("camera row address is invalid");
    const auto unsigned_address = static_cast<std::uintptr_t>(address);
    if (unsigned_address < begin || unsigned_address > end ||
        row_bytes > end - unsigned_address) {
      throw std::runtime_error("camera frame exceeds its media buffer");
    }
  }
}

void unlock2D(IMF2DBuffer* buffer) noexcept {
  if (buffer) buffer->Unlock2D();
}

void unlockBuffer(IMFMediaBuffer* buffer) noexcept {
  if (buffer) buffer->Unlock();
}

void copySampleToFrame(
  IMFSample* sample,
  IMFMediaType* type,
  CameraFrame& frame
) {
  const auto format = readFormat(type);
  if (!validFormat(format)) {
    throw std::runtime_error("camera frame dimensions unavailable");
  }

  DWORD buffer_count = 0;
  check(sample->GetBufferCount(&buffer_count), "camera buffer count unavailable");
  ComPtr<IMFMediaBuffer> buffer;
  if (buffer_count == 1) {
    check(sample->GetBufferByIndex(0, &buffer), "camera buffer unavailable");
  } else {
    check(sample->ConvertToContiguousBuffer(&buffer), "camera buffer conversion failed");
  }

  ComPtr<IMF2DBuffer2> buffer_2d_v2;
  if (SUCCEEDED(buffer.As(&buffer_2d_v2))) {
    BYTE* scanline_zero = nullptr;
    BYTE* buffer_start = nullptr;
    LONG pitch = 0;
    DWORD buffer_length = 0;
    check(buffer_2d_v2->Lock2DSize(
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
      unlock2D(buffer_2d_v2.Get());
      throw;
    }
    check(buffer_2d_v2->Unlock2D(), "camera 2D buffer unlock failed");
  } else {
    ComPtr<IMF2DBuffer> buffer_2d;
    if (SUCCEEDED(buffer.As(&buffer_2d))) {
      BYTE* scanline_zero = nullptr;
      LONG pitch = 0;
      check(buffer_2d->Lock2D(&scanline_zero, &pitch), "camera 2D buffer lock failed");
      try {
        frame.bgra = copyCameraBgraRows(
          scanline_zero, pitch, format.width, format.height);
      } catch (...) {
        unlock2D(buffer_2d.Get());
        throw;
      }
      check(buffer_2d->Unlock2D(), "camera 2D buffer unlock failed");
    } else {
      BYTE* bytes = nullptr;
      DWORD current_length = 0;
      check(buffer->Lock(&bytes, nullptr, &current_length),
        "camera buffer lock failed");
      try {
        UINT32 raw_stride = 0;
        LONG stride = static_cast<LONG>(format.width * 4);
        if (SUCCEEDED(type->GetUINT32(MF_MT_DEFAULT_STRIDE, &raw_stride))) {
          stride = static_cast<LONG>(raw_stride);
        }
        const auto absolute_stride = static_cast<std::uint64_t>(
          stride < 0 ? -static_cast<std::int64_t>(stride) : stride);
        const auto row_bytes = static_cast<std::uint64_t>(format.width) * 4;
        const auto required_length =
          absolute_stride * (static_cast<std::uint64_t>(format.height) - 1) +
          row_bytes;
        if (absolute_stride < row_bytes || required_length > current_length) {
          throw std::runtime_error("camera contiguous buffer has an invalid stride");
        }
        const auto scanline_zero = stride < 0
          ? bytes + absolute_stride * (static_cast<std::uint64_t>(format.height) - 1)
          : bytes;
        frame.bgra = copyCameraBgraRows(
          scanline_zero, stride, format.width, format.height);
      } catch (...) {
        unlockBuffer(buffer.Get());
        throw;
      }
      check(buffer->Unlock(), "camera buffer unlock failed");
    }
  }
  frame.width = format.width;
  frame.height = format.height;
}

std::wstring wide(const std::string& value) {
  if (value.empty()) return {};
  const auto size = MultiByteToWideChar(CP_UTF8, 0, value.data(),
    static_cast<int>(value.size()), nullptr, 0);
  std::wstring result(static_cast<std::size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
    result.data(), size);
  return result;
}

std::string utf8(const WCHAR* value, UINT32 length) {
  if (!value || length == 0) return {};
  const auto size = WideCharToMultiByte(CP_UTF8, 0, value,
    static_cast<int>(length), nullptr, 0, nullptr, nullptr);
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, static_cast<int>(length),
    result.data(), size, nullptr, nullptr);
  return result;
}

class MfCameraCapture final : public CameraCapture {
 public:
  MfCameraCapture(const std::string& id, std::uint32_t width, std::uint32_t height, int fps) {
    ActivateArray devices;
    ComPtr<IMFAttributes> attributes;
    check(MFCreateAttributes(&attributes, 1), "camera attributes creation failed");
    check(attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
      MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID), "camera source type failed");
    check(MFEnumDeviceSources(
        attributes.Get(), &devices.values, &devices.count),
      "camera enumeration failed");
    const auto wanted = wide(id);
    for (UINT32 index = 0; index < devices.count && !source_; ++index) {
      WCHAR* symbolic = nullptr;
      UINT32 length = 0;
      devices.values[index]->GetAllocatedString(
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &symbolic, &length);
      const bool match = wanted.empty() || (symbolic && wanted == symbolic);
      CoTaskMemFree(symbolic);
      if (match) {
        check(devices.values[index]->ActivateObject(IID_PPV_ARGS(&source_)),
          "camera activation failed");
      }
    }
    if (!source_) throw std::runtime_error("camera device not found");

    ComPtr<IMFAttributes> reader_attributes;
    check(MFCreateAttributes(&reader_attributes, 3),
      "camera reader attributes creation failed");
    check(reader_attributes->SetUINT32(
        MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE),
      "camera advanced video processing setup failed");
    check(reader_attributes->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, FALSE),
      "camera converter setup failed");
    check(reader_attributes->SetUINT32(
        MF_SOURCE_READER_DISCONNECT_MEDIASOURCE_ON_SHUTDOWN, TRUE),
      "camera source shutdown setup failed");
    check(MFCreateSourceReaderFromMediaSource(
        source_.Get(), reader_attributes.Get(), &reader_),
      "camera reader creation failed");
    negotiateRgb32Format(reader_.Get(), CameraFormat{
      width, height, static_cast<std::uint32_t>(fps), 1});
  }

  ~MfCameraCapture() override {
    reader_.Reset();
    if (source_) source_->Shutdown();
  }

  bool read(CameraFrame& frame, const std::atomic_bool& running) override {
    if (!running.load()) return false;
    DWORD flags = 0;
    ComPtr<IMFSample> sample;
    check(reader_->ReadSample(video_stream, 0, nullptr,
      &flags, nullptr, &sample), "camera sample read failed");
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) {
      throw std::runtime_error("camera stream ended");
    }
    if (!sample) return true;
    ComPtr<IMFMediaType> type;
    check(reader_->GetCurrentMediaType(video_stream, &type),
      "camera media type unavailable");
    copySampleToFrame(sample.Get(), type.Get(), frame);
    return true;
  }

 private:
  ComPtr<IMFMediaSource> source_;
  ComPtr<IMFSourceReader> reader_;
};

class MfCameraCaptureFactory final : public CameraCaptureFactory {
 public:
  std::unique_ptr<CameraCapture> create(
    const std::string& id, std::uint32_t width, std::uint32_t height, int fps
  ) override {
    return std::make_unique<MfCameraCapture>(id, width, height, fps);
  }
};
}  // namespace

std::vector<CameraFormat> rankCameraOutputFormats(
  CameraFormat requested,
  std::vector<CameraFormat> native_formats
) {
  if (!validFormat(requested)) {
    throw std::invalid_argument("requested camera format is invalid");
  }
  native_formats.erase(
    std::remove_if(native_formats.begin(), native_formats.end(),
      [](const auto& format) { return !validFormat(format); }),
    native_formats.end());
  std::stable_sort(native_formats.begin(), native_formats.end(),
    [&](const auto& left, const auto& right) {
      return formatDistance(left, requested) < formatDistance(right, requested);
    });

  std::vector<CameraFormat> result{requested};
  for (const auto& format : native_formats) {
    if (std::find(result.begin(), result.end(), format) == result.end()) {
      result.push_back(format);
    }
  }
  return result;
}

std::vector<std::uint8_t> copyCameraBgraRows(
  const std::uint8_t* scanline_zero,
  std::ptrdiff_t stride,
  std::uint32_t width,
  std::uint32_t height
) {
  if (!scanline_zero || width == 0 || height == 0) {
    throw std::invalid_argument("camera frame geometry is invalid");
  }
  const auto row_bytes = static_cast<std::size_t>(width) * 4;
  if (row_bytes / 4 != width ||
      height > std::numeric_limits<std::size_t>::max() / row_bytes) {
    throw std::overflow_error("camera frame size overflow");
  }
  const auto absolute_stride = stride < 0 ? -stride : stride;
  if (static_cast<std::size_t>(absolute_stride) < row_bytes) {
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

std::shared_ptr<CameraCaptureFactory> createMediaFoundationCameraCaptureFactory() {
  return std::make_shared<MfCameraCaptureFactory>();
}

std::vector<DeviceInfo> listCameraDevices() {
  check(MFStartup(MF_VERSION, MFSTARTUP_LITE), "Media Foundation startup failed");
  struct Shutdown { ~Shutdown() { MFShutdown(); } } shutdown;
  ComPtr<IMFAttributes> attributes;
  check(MFCreateAttributes(&attributes, 1), "camera attributes creation failed");
  check(attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID), "camera source type failed");
  ActivateArray devices;
  check(MFEnumDeviceSources(
      attributes.Get(), &devices.values, &devices.count),
    "camera enumeration failed");
  std::vector<DeviceInfo> result;
  for (UINT32 index = 0; index < devices.count; ++index) {
    WCHAR* id = nullptr; UINT32 id_length = 0;
    WCHAR* name = nullptr; UINT32 name_length = 0;
    devices.values[index]->GetAllocatedString(
      MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &id, &id_length);
    devices.values[index]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
      &name, &name_length);
    result.push_back(DeviceInfo{utf8(id, id_length), utf8(name, name_length),
      "videoinput", index == 0});
    CoTaskMemFree(id); CoTaskMemFree(name);
  }
  return result;
}
}  // namespace syrnike::desktop_native::media
