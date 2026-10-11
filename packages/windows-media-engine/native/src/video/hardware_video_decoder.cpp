#include "video/hardware_video_decoder.hpp"

#include <codecapi.h>
#include <d3d11_1.h>
#include <livekit/external_video_decoder.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <strmif.h>

#include <algorithm>
#include <cstring>
#include <mutex>
#include <optional>
#include <vector>

#include "capture/d3d11_device.hpp"

namespace syrnike::windows_media::video {
namespace {

using Microsoft::WRL::ComPtr;

// Frames held by the SDK queue, the track owner and the pool upload. More
// outstanding means a stalled consumer; new frames are dropped until it drains.
constexpr std::size_t kMaximumOutstandingFrames = 8;
constexpr LONGLONG kSampleDuration100ns = 166'667;

struct ComApartment {
  ComApartment() : initialized(SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {}
  ~ComApartment() {
    if (initialized) CoUninitialize();
  }
  const bool initialized;
};

bool startMediaFoundation() {
  thread_local ComApartment apartment;
  static const bool started = SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_LITE));
  return started;
}

struct OutputTexture {
  ComPtr<ID3D11Texture2D> texture;
  ComPtr<ID3D11VideoProcessorOutputView> view;
};

// Reusable BGRA outputs of the current size. Shared with frames so that a
// frame released after its decoder still returns safely.
struct OutputTextures {
  std::mutex mutex;
  std::uint32_t width = 0, height = 0;
  std::vector<OutputTexture> free;
  std::size_t outstanding = 0;
};

DXGI_COLOR_SPACE_TYPE inputColorSpace(IMFMediaType* type, std::uint32_t height) {
  UINT32 matrix = MFVideoTransferMatrix_Unknown, range = MFNominalRange_Unknown;
  (void)type->GetUINT32(MF_MT_YUV_MATRIX, &matrix);
  (void)type->GetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, &range);
  // Unsignalled streams follow the usual convention: SD is BT.601, HD BT.709.
  const bool bt601 = matrix == MFVideoTransferMatrix_BT601 ||
                     (matrix != MFVideoTransferMatrix_BT709 && height < 720);
  if (range == MFNominalRange_0_255)
    return bt601 ? DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P601
                 : DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P709;
  return bt601 ? DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P601
               : DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709;
}

ComPtr<IMFTransform> findDxvaH264Decoder() {
  MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_H264};
  MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_NV12};
  IMFActivate** activates = nullptr;
  UINT32 count = 0;
  if (FAILED(MFTEnumEx(MFT_CATEGORY_VIDEO_DECODER,
                       MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_LOCALMFT |
                           MFT_ENUM_FLAG_SORTANDFILTER,
                       &input, &output, &activates, &count)))
    return nullptr;
  ComPtr<IMFTransform> found;
  for (UINT32 index = 0; index < count; ++index) {
    ComPtr<IMFTransform> transform;
    ComPtr<IMFAttributes> attributes;
    UINT32 d3d11_aware = 0;
    if (!found && SUCCEEDED(activates[index]->ActivateObject(IID_PPV_ARGS(&transform))) &&
        SUCCEEDED(transform->GetAttributes(&attributes)) &&
        SUCCEEDED(attributes->GetUINT32(MF_SA_D3D11_AWARE, &d3d11_aware)) && d3d11_aware)
      found = transform;
    activates[index]->Release();
  }
  CoTaskMemFree(activates);
  return found;
}

class MediaFoundationH264Decoder final : public HardwareVideoDecoder {
 public:
  bool initialize() {
    device_ = capture::processD3d11Device(false);
    if (!device_ || FAILED(device_->device()->QueryInterface(IID_PPV_ARGS(&video_device_))) ||
        FAILED(device_->context()->QueryInterface(IID_PPV_ARGS(&video_context_))))
      return false;
    transform_ = findDxvaH264Decoder();
    if (!transform_) return false;
    ComPtr<IMFAttributes> attributes;
    if (SUCCEEDED(transform_->GetAttributes(&attributes)))
      (void)attributes->SetUINT32(MF_LOW_LATENCY, TRUE);
    ComPtr<ICodecAPI> codec;
    if (SUCCEEDED(transform_.As(&codec))) {
      VARIANT value{};
      value.vt = VT_BOOL;
      value.boolVal = VARIANT_TRUE;
      (void)codec->SetValue(&CODECAPI_AVLowLatencyMode, &value);
    }
    UINT token = 0;
    if (FAILED(MFCreateDXGIDeviceManager(&token, &manager_)) ||
        FAILED(manager_->ResetDevice(device_->device(), token)) ||
        // Without DXVA the decoder would silently decode on the CPU.
        FAILED(transform_->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER,
                                          reinterpret_cast<ULONG_PTR>(manager_.Get()))))
      return false;
    ComPtr<IMFMediaType> input;
    if (FAILED(MFCreateMediaType(&input)) ||
        FAILED(input->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
        FAILED(input->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264)) ||
        FAILED(transform_->SetInputType(0, input.Get(), 0)) || !selectOutputType())
      return false;
    MFT_OUTPUT_STREAM_INFO info{};
    if (FAILED(transform_->GetOutputStreamInfo(0, &info)) ||
        !(info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES))
      return false;
    return SUCCEEDED(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)) &&
           SUCCEEDED(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0));
  }

  ~MediaFoundationH264Decoder() override {
    if (transform_) {
      (void)transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
      (void)transform_->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, 0);
    }
  }

  Result decode(std::span<const std::uint8_t> access_unit, bool keyframe,
                std::shared_ptr<DecodedVideoFrame>& frame) override {
    startMediaFoundation();
    ComPtr<IMFSample> input;
    ComPtr<IMFMediaBuffer> buffer;
    BYTE* bytes = nullptr;
    if (FAILED(MFCreateSample(&input)) ||
        FAILED(MFCreateMemoryBuffer(static_cast<DWORD>(access_unit.size()), &buffer)) ||
        FAILED(buffer->Lock(&bytes, nullptr, nullptr)))
      return Result::Error;
    std::memcpy(bytes, access_unit.data(), access_unit.size());
    (void)buffer->Unlock();
    (void)buffer->SetCurrentLength(static_cast<DWORD>(access_unit.size()));
    (void)input->AddBuffer(buffer.Get());
    (void)input->SetSampleTime(sample_time_);
    (void)input->SetSampleDuration(kSampleDuration100ns);
    sample_time_ += kSampleDuration100ns;
    if (keyframe) (void)input->SetUINT32(MFSampleExtension_CleanPoint, TRUE);

    ComPtr<IMFSample> latest;
    HRESULT result = transform_->ProcessInput(0, input.Get(), 0);
    if (result == MF_E_NOTACCEPTING) {
      if (const auto drained = drain(latest); drained != Result::NoFrame) return drained;
      result = transform_->ProcessInput(0, input.Get(), 0);
    }
    if (FAILED(result)) return failure(result);
    if (const auto drained = drain(latest); drained != Result::NoFrame) return drained;
    if (!latest) return Result::NoFrame;
    return convert(latest.Get(), frame);
  }

 private:
  bool selectOutputType() {
    for (DWORD index = 0;; ++index) {
      ComPtr<IMFMediaType> type;
      if (FAILED(transform_->GetOutputAvailableType(0, index, &type))) return false;
      GUID subtype{};
      if (SUCCEEDED(type->GetGUID(MF_MT_SUBTYPE, &subtype)) && subtype == MFVideoFormat_NV12 &&
          SUCCEEDED(transform_->SetOutputType(0, type.Get(), 0))) {
        output_type_ = type;
        UINT32 width = 0, height = 0;
        (void)MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &width, &height);
        MFVideoArea area{};
        if (SUCCEEDED(type->GetBlob(MF_MT_MINIMUM_DISPLAY_APERTURE,
                                    reinterpret_cast<UINT8*>(&area), sizeof(area), nullptr)) &&
            area.Area.cx > 0 && area.Area.cy > 0) {
          visible_ = {area.OffsetX.value, area.OffsetY.value, area.OffsetX.value + area.Area.cx,
                      area.OffsetY.value + area.Area.cy};
        } else {
          visible_ = {0, 0, static_cast<LONG>(width), static_cast<LONG>(height)};
        }
        return true;
      }
    }
  }

  // Leaves the newest decoded picture in `latest`; NoFrame means success.
  Result drain(ComPtr<IMFSample>& latest) {
    while (true) {
      MFT_OUTPUT_DATA_BUFFER output{};
      DWORD status = 0;
      const HRESULT result = transform_->ProcessOutput(0, 1, &output, &status);
      if (output.pEvents) output.pEvents->Release();
      ComPtr<IMFSample> sample;
      sample.Attach(output.pSample);
      if (result == MF_E_TRANSFORM_NEED_MORE_INPUT) return Result::NoFrame;
      if (result == MF_E_TRANSFORM_STREAM_CHANGE) {
        if (!selectOutputType()) return Result::Error;
        continue;
      }
      if (FAILED(result)) return failure(result);
      if (sample) latest = std::move(sample);
    }
  }

  Result failure(HRESULT result) const {
    if (result == DXGI_ERROR_DEVICE_REMOVED || result == DXGI_ERROR_DEVICE_RESET ||
        FAILED(device_->device()->GetDeviceRemovedReason()))
      return Result::Fallback;
    return Result::Error;
  }

  bool configureProcessor(std::uint32_t input_width, std::uint32_t input_height) {
    const auto width = static_cast<std::uint32_t>(visible_.right - visible_.left);
    const auto height = static_cast<std::uint32_t>(visible_.bottom - visible_.top);
    if (processor_ && input_width == input_width_ && input_height == input_height_ &&
        width == outputs_->width && height == outputs_->height)
      return true;
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = input_width;
    content.InputHeight = input_height;
    content.OutputWidth = width;
    content.OutputHeight = height;
    content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    ComPtr<ID3D11VideoProcessor> processor;
    if (FAILED(video_device_->CreateVideoProcessorEnumerator(&content, &enumerator)) ||
        FAILED(video_device_->CreateVideoProcessor(enumerator.Get(), 0, &processor)))
      return false;
    enumerator_ = std::move(enumerator);
    processor_ = std::move(processor);
    input_width_ = input_width;
    input_height_ = input_height;
    std::scoped_lock lock(outputs_->mutex);
    outputs_->width = width;
    outputs_->height = height;
    outputs_->free.clear();
    return true;
  }

  // Null when all outputs are still held downstream.
  std::optional<OutputTexture> takeOutput() {
    {
      std::scoped_lock lock(outputs_->mutex);
      if (outputs_->outstanding >= kMaximumOutstandingFrames) return std::nullopt;
      ++outputs_->outstanding;
      if (!outputs_->free.empty()) {
        auto output = std::move(outputs_->free.back());
        outputs_->free.pop_back();
        return output;
      }
    }
    OutputTexture output;
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = outputs_->width;
    desc.Height = outputs_->height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC view{};
    view.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    if (FAILED(device_->device()->CreateTexture2D(&desc, nullptr, &output.texture)) ||
        FAILED(video_device_->CreateVideoProcessorOutputView(output.texture.Get(),
                                                             enumerator_.Get(), &view,
                                                             &output.view))) {
      std::scoped_lock lock(outputs_->mutex);
      --outputs_->outstanding;
      return std::nullopt;
    }
    return output;
  }

  std::shared_ptr<DecodedVideoFrame> wrap(OutputTexture output) {
    auto outputs = outputs_;
    auto* decoded = new DecodedVideoFrame{output.texture, outputs->width, outputs->height};
    return {decoded, [outputs, output = std::move(output)](DecodedVideoFrame* released) mutable {
              {
                std::scoped_lock lock(outputs->mutex);
                --outputs->outstanding;
                if (released->width == outputs->width && released->height == outputs->height)
                  outputs->free.push_back(std::move(output));
              }
              delete released;
            }};
  }

  Result convert(IMFSample* sample, std::shared_ptr<DecodedVideoFrame>& frame) {
    ComPtr<IMFMediaBuffer> buffer;
    ComPtr<IMFDXGIBuffer> dxgi;
    ComPtr<ID3D11Texture2D> surface;
    UINT subresource = 0;
    if (FAILED(sample->GetBufferByIndex(0, &buffer)) || FAILED(buffer.As(&dxgi)) ||
        FAILED(dxgi->GetResource(IID_PPV_ARGS(&surface))) ||
        FAILED(dxgi->GetSubresourceIndex(&subresource)))
      return Result::Fallback;  // system-memory output is not hardware decoding
    D3D11_TEXTURE2D_DESC surface_desc{};
    surface->GetDesc(&surface_desc);
    if (visible_.right <= visible_.left || visible_.bottom <= visible_.top ||
        static_cast<UINT>(visible_.right) > surface_desc.Width ||
        static_cast<UINT>(visible_.bottom) > surface_desc.Height)
      visible_ = {0, 0, static_cast<LONG>(surface_desc.Width),
                  static_cast<LONG>(surface_desc.Height)};
    if (!configureProcessor(surface_desc.Width, surface_desc.Height)) return failure(E_FAIL);
    auto output = takeOutput();
    if (!output) return Result::NoFrame;
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input_desc{};
    input_desc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    input_desc.Texture2D.ArraySlice = subresource;
    ComPtr<ID3D11VideoProcessorInputView> input;
    HRESULT result = video_device_->CreateVideoProcessorInputView(
        surface.Get(), enumerator_.Get(), &input_desc, &input);
    if (SUCCEEDED(result)) {
      const RECT destination{0, 0, static_cast<LONG>(outputs_->width),
                             static_cast<LONG>(outputs_->height)};
      std::scoped_lock context_lock(device_->contextMutex());
      video_context_->VideoProcessorSetStreamFrameFormat(processor_.Get(), 0,
                                                         D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
      video_context_->VideoProcessorSetStreamAutoProcessingMode(processor_.Get(), 0, FALSE);
      video_context_->VideoProcessorSetStreamSourceRect(processor_.Get(), 0, TRUE, &visible_);
      video_context_->VideoProcessorSetStreamDestRect(processor_.Get(), 0, TRUE, &destination);
      video_context_->VideoProcessorSetOutputTargetRect(processor_.Get(), TRUE, &destination);
      ComPtr<ID3D11VideoContext1> context1;
      if (SUCCEEDED(video_context_.As(&context1))) {
        context1->VideoProcessorSetStreamColorSpace1(
            processor_.Get(), 0, inputColorSpace(output_type_.Get(), outputs_->height));
        context1->VideoProcessorSetOutputColorSpace1(processor_.Get(),
                                                     DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
      }
      D3D11_VIDEO_PROCESSOR_STREAM stream{};
      stream.Enable = TRUE;
      stream.pInputSurface = input.Get();
      result = video_context_->VideoProcessorBlt(processor_.Get(), output->view.Get(), 0, 1,
                                                 &stream);
    }
    frame = wrap(std::move(*output));
    if (FAILED(result)) {
      frame.reset();
      return failure(result);
    }
    return Result::Frame;
  }

  std::shared_ptr<capture::D3d11DeviceOwner> device_;
  ComPtr<ID3D11VideoDevice> video_device_;
  ComPtr<ID3D11VideoContext> video_context_;
  ComPtr<IMFDXGIDeviceManager> manager_;
  ComPtr<IMFTransform> transform_;
  ComPtr<IMFMediaType> output_type_;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator_;
  ComPtr<ID3D11VideoProcessor> processor_;
  std::uint32_t input_width_ = 0, input_height_ = 0;
  RECT visible_{};
  LONGLONG sample_time_ = 0;
  std::shared_ptr<OutputTextures> outputs_ = std::make_shared<OutputTextures>();
};

std::uint8_t clampByte(int value) {
  return static_cast<std::uint8_t>(std::clamp(value, 0, 255));
}

// --- LiveKit external decoder ABI --------------------------------------------

using FrameReference = std::shared_ptr<DecodedVideoFrame>;

void* createDecoder(void*, std::int32_t codec) {
  if (codec != LK_EXTERNAL_VIDEO_CODEC_H264) return nullptr;
  try {
    return HardwareVideoDecoder::createH264().release();
  } catch (...) {
    return nullptr;
  }
}

void destroyDecoder(void* decoder) { delete static_cast<HardwareVideoDecoder*>(decoder); }

std::int32_t decodeAccessUnit(void* decoder, const std::uint8_t* data, std::size_t size,
                              std::int32_t keyframe, LkExternalVideoFrame* out) {
  try {
    FrameReference frame;
    switch (static_cast<HardwareVideoDecoder*>(decoder)->decode({data, size}, keyframe != 0,
                                                                frame)) {
      case HardwareVideoDecoder::Result::Frame:
        out->width = static_cast<std::int32_t>(frame->width);
        out->height = static_cast<std::int32_t>(frame->height);
        out->frame = new FrameReference(std::move(frame));
        return LK_EXTERNAL_DECODE_FRAME;
      case HardwareVideoDecoder::Result::NoFrame:
        return LK_EXTERNAL_DECODE_NO_FRAME;
      case HardwareVideoDecoder::Result::Fallback:
        return LK_EXTERNAL_DECODE_FALLBACK;
      case HardwareVideoDecoder::Result::Error:
        break;
    }
  } catch (...) {
  }
  return LK_EXTERNAL_DECODE_ERROR;
}

void releaseFrame(void* frame) { delete static_cast<FrameReference*>(frame); }

std::int32_t readI420(void* frame, std::uint8_t* y, std::int32_t stride_y, std::uint8_t* u,
                      std::int32_t stride_u, std::uint8_t* v, std::int32_t stride_v) {
  try {
    return readDecodedFrameI420(**static_cast<FrameReference*>(frame), y, stride_y, u, stride_u,
                                v, stride_v)
               ? 0
               : 1;
  } catch (...) {
    return 1;
  }
}

constexpr LkExternalVideoDecoder kDecoder{LK_EXTERNAL_VIDEO_DECODER_ABI, nullptr, createDecoder,
                                          destroyDecoder, decodeAccessUnit, releaseFrame,
                                          readI420};

}  // namespace

std::unique_ptr<HardwareVideoDecoder> HardwareVideoDecoder::createH264() {
  if (!startMediaFoundation()) return nullptr;
  auto decoder = std::make_unique<MediaFoundationH264Decoder>();
  if (!decoder->initialize()) return nullptr;
  return decoder;
}

bool readDecodedFrameI420(const DecodedVideoFrame& frame, std::uint8_t* y, int stride_y,
                          std::uint8_t* u, int stride_u, std::uint8_t* v, int stride_v) {
  const auto device = capture::processD3d11Device(false);
  D3D11_TEXTURE2D_DESC desc{};
  frame.texture->GetDesc(&desc);
  desc.Usage = D3D11_USAGE_STAGING;
  desc.BindFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  desc.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> staging;
  if (FAILED(device->device()->CreateTexture2D(&desc, nullptr, &staging))) return false;
  std::scoped_lock lock(device->contextMutex());
  device->context()->CopyResource(staging.Get(), frame.texture.Get());
  D3D11_MAPPED_SUBRESOURCE mapped{};
  if (FAILED(device->context()->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped))) return false;
  // BT.709 limited range, matching what the decoder converted from.
  for (std::uint32_t row = 0; row < frame.height; ++row) {
    const auto* pixel = static_cast<const std::uint8_t*>(mapped.pData) + row * mapped.RowPitch;
    for (std::uint32_t column = 0; column < frame.width; ++column, pixel += 4) {
      const int b = pixel[0], g = pixel[1], r = pixel[2];
      y[row * stride_y + column] = clampByte(16 + ((47 * r + 157 * g + 16 * b + 128) >> 8));
      if ((row | column) & 1) continue;
      u[(row / 2) * stride_u + column / 2] =
          clampByte(128 + ((-26 * r - 87 * g + 112 * b + 128) >> 8));
      v[(row / 2) * stride_v + column / 2] =
          clampByte(128 + ((112 * r - 102 * g - 10 * b + 128) >> 8));
    }
  }
  device->context()->Unmap(staging.Get(), 0);
  return true;
}

void installHardwareVideoDecoder() { livekit::setExternalVideoDecoder(&kDecoder); }

}  // namespace syrnike::windows_media::video
