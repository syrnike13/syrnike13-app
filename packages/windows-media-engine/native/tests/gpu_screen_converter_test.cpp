#include <d3d11.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <vector>

#include "capture/d3d11_device.hpp"
#include "screen/gpu_screen_converter.hpp"
#include "screen/production_screen_pipeline.hpp"
#include "screen/screen_frame_marker.hpp"

namespace syrnike::windows_media::screen::tests {
void hardwareH264ProbeCoversFixedProfiles();
void hardwareH264EncoderProducesBoundedAnnexBOutput();
void encodedBackpressureKeepsEveryReferenceFrame();
void hardwareKeyframeRequestAppliesToNextInput();
void productionGpuPipelineStartsHardwareBeforePublicationAndStops();
}  // namespace syrnike::windows_media::screen::tests

namespace {

using Microsoft::WRL::ComPtr;
using namespace syrnike::windows_media::capture;
using namespace syrnike::windows_media::screen;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

ComPtr<ID3D11Texture2D> solidBgra(const std::shared_ptr<D3d11DeviceOwner>& owner,
                                  std::uint32_t width, std::uint32_t height,
                                  std::array<std::uint8_t, 4> bgra) {
  std::vector<std::uint8_t> pixels(width * height * 4ULL);
  for (std::size_t offset = 0; offset < pixels.size(); offset += 4)
    std::copy(bgra.begin(), bgra.end(), pixels.begin() + offset);
  D3D11_TEXTURE2D_DESC description{};
  description.Width = width;
  description.Height = height;
  description.MipLevels = 1;
  description.ArraySize = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_DEFAULT;
  description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  const D3D11_SUBRESOURCE_DATA initial{pixels.data(), width * 4U, 0};
  ComPtr<ID3D11Texture2D> texture;
  require(SUCCEEDED(owner->device()->CreateTexture2D(&description, &initial, &texture)),
          "synthetic BGRA texture creation failed");
  return texture;
}

std::array<std::uint8_t, 3> readNv12Pixel(const std::shared_ptr<D3d11DeviceOwner>& owner,
                                          ID3D11Texture2D* source, std::uint32_t width,
                                          std::uint32_t height, std::uint32_t x = UINT32_MAX,
                                          std::uint32_t y = UINT32_MAX) {
  D3D11_TEXTURE2D_DESC description{};
  source->GetDesc(&description);
  description.Usage = D3D11_USAGE_STAGING;
  description.BindFlags = 0;
  description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  description.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> staging;
  require(SUCCEEDED(owner->device()->CreateTexture2D(&description, nullptr, &staging)),
          "NV12 staging texture creation failed");
  D3D11_MAPPED_SUBRESOURCE mapped{};
  {
    std::lock_guard lock(owner->contextMutex());
    owner->context()->CopyResource(staging.Get(), source);
    require(SUCCEEDED(owner->context()->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped)),
            "NV12 staging map failed");
  }
  const auto* bytes = static_cast<const std::uint8_t*>(mapped.pData);
  if (x == UINT32_MAX) x = width / 2;
  if (y == UINT32_MAX) y = height / 2;
  const std::array result{
      bytes[y * mapped.RowPitch + x],
      bytes[height * mapped.RowPitch + (y / 2) * mapped.RowPitch + (x & ~1U)],
      bytes[height * mapped.RowPitch + (y / 2) * mapped.RowPitch + (x & ~1U) + 1]};
  {
    std::lock_guard lock(owner->contextMutex());
    owner->context()->Unmap(staging.Get(), 0);
  }
  return result;
}

std::uint16_t readMarkerMagic(const std::shared_ptr<D3d11DeviceOwner>& owner,
                              ID3D11Texture2D* source, std::uint32_t width, std::uint32_t height) {
  D3D11_TEXTURE2D_DESC staging_description{};
  staging_description.Width = width;
  staging_description.Height = height;
  staging_description.MipLevels = 1;
  staging_description.ArraySize = 1;
  staging_description.Format = DXGI_FORMAT_NV12;
  staging_description.SampleDesc.Count = 1;
  staging_description.Usage = D3D11_USAGE_STAGING;
  staging_description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> staging;
  require(SUCCEEDED(owner->device()->CreateTexture2D(&staging_description, nullptr, &staging)),
          "NV12 marker staging texture creation failed");
  D3D11_MAPPED_SUBRESOURCE mapped{};
  {
    std::lock_guard lock(owner->contextMutex());
    owner->context()->CopyResource(staging.Get(), source);
    require(SUCCEEDED(owner->context()->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped)),
            "NV12 marker staging map failed");
  }
  const auto* bytes = static_cast<const std::uint8_t*>(mapped.pData);
  std::uint16_t result = 0;
  for (std::size_t bit = 0; bit < 16; ++bit) {
    const auto column = bit % kScreenMarkerColumns;
    const auto row = bit / kScreenMarkerColumns;
    const auto x = column * kScreenMarkerTileSize + kScreenMarkerTileSize / 2;
    const auto y = row * kScreenMarkerTileSize + kScreenMarkerTileSize / 2;
    result = static_cast<std::uint16_t>((result << 1U) |
                                        (bytes[y * mapped.RowPitch + x] >= 128 ? 1U : 0U));
  }
  {
    std::lock_guard lock(owner->contextMutex());
    owner->context()->Unmap(staging.Get(), 0);
  }
  return result;
}

void convertsSolidRedWithinBt709Tolerance() {
  const auto owner = processD3d11Device(false);
  constexpr ScreenVideoProfile profile{1280, 720, 30, 4'000'000};
  GpuScreenConverter converter(owner, profile);
  const auto source = solidBgra(owner, 320, 180, {0, 0, 255, 255});
  const auto converted =
      converter.convert({owner, source.Get()}, {1, 1, 320, 180, FramePixelFormat::Bgra8, 1});
  require(converted.has_value(), "GPU conversion rejected a valid frame");
  const auto actual = readNv12Pixel(owner, converted->texture(), profile.width, profile.height);
  constexpr std::array<std::uint8_t, 3> bt709_red{63, 102, 240};
  for (std::size_t channel = 0; channel < actual.size(); ++channel) {
    require(
        std::abs(static_cast<int>(actual[channel]) - static_cast<int>(bt709_red[channel])) <= 16,
        "GPU NV12 output exceeded BT.709 tolerance");
  }
}

void slotPoolIsFixedAndReturnsReleasedSlots() {
  const auto owner = processD3d11Device(false);
  constexpr ScreenVideoProfile profile{1280, 720, 30, 4'000'000};
  GpuScreenConverter converter(owner, profile);
  const auto source = solidBgra(owner, 320, 180, {0, 0, 0, 255});
  const FrameMetadata metadata{1, 1, 320, 180, FramePixelFormat::Bgra8, 1};
  auto first = converter.convert({owner, source.Get()}, metadata);
  auto second = converter.convert({owner, source.Get()}, metadata);
  auto third = converter.convert({owner, source.Get()}, metadata);
  require(first && second && third, "fixed NV12 pool did not expose three slots");
  require(!converter.convert({owner, source.Get()}, metadata),
          "fixed NV12 pool grew past its declared capacity");
  const auto released_slot = second->slot();
  second.reset();
  auto reused = converter.convert({owner, source.Get()}, metadata);
  require(reused && reused->slot() == released_slot, "released NV12 slot was not reused");
  const auto stats = converter.stats();
  require(stats.pool_capacity == kGpuConversionSlotCapacity &&
              stats.slots_in_use == kGpuConversionSlotCapacity &&
              stats.maximum_in_use == kGpuConversionSlotCapacity && stats.pool_exhausted == 1,
          "GPU slot accounting was not bounded");
}

void inputViewsDoNotSurviveBackendGenerations() {
  const auto owner = processD3d11Device(false);
  GpuScreenConverter converter(owner, kScreenProfile720p30);
  const auto source = solidBgra(owner, 320, 180, {0, 0, 255, 255});
  for (const auto generation : {1U, 1U, 2U, 2U, 3U}) {
    const auto frame = converter.convert({owner, source.Get()},
                                         {1, 1, 320, 180, FramePixelFormat::Bgra8, generation});
    require(frame.has_value(), "generation transition rejected conversion");
  }
  require(converter.stats().input_views_created == 5,
          "converter cached a view beyond its capture frame lease");
  require(converter.stats().processor_reconfigurations == 1,
          "backend generation unnecessarily recreated the video processor");
}

void oddInputDimensionsUseAnEvenCrop() {
  const auto owner = processD3d11Device(false);
  GpuScreenConverter converter(owner, kScreenProfile720p30);
  const auto source = solidBgra(owner, 321, 181, {255, 0, 0, 255});
  const auto converted =
      converter.convert({owner, source.Get()}, {1, 1, 321, 181, FramePixelFormat::Bgra8, 1});
  require(converted.has_value(), "GPU conversion rejected an odd-sized source crop");
}

void otherAspectRatiosAreLetterboxedNotCropped() {
  const auto owner = processD3d11Device(false);
  GpuScreenConverter converter(owner, kScreenProfile720p30);
  // A portrait window: 180x320 scales to 404x720, centred in 1280x720.
  const auto source = solidBgra(owner, 180, 320, {255, 255, 255, 255});
  const auto converted =
      converter.convert({owner, source.Get()}, {1, 1, 180, 320, FramePixelFormat::Bgra8, 1});
  require(converted.has_value(), "portrait conversion failed");
  const auto luma = [&](std::uint32_t x, std::uint32_t y) {
    return readNv12Pixel(owner, converted->texture(), 1280, 720, x, y)[0];
  };
  require(luma(640, 360) > 200 && luma(640, 4) > 200 && luma(640, 715) > 200,
          "portrait source lost its top or bottom");
  require(luma(100, 360) < 32 && luma(1180, 360) < 32, "letterbox bars are not black");
}

void streamFollowsTheSourceAspectRatio() {
  const auto fit = [](ScreenVideoProfile box, std::uint32_t w, std::uint32_t h) {
    const auto out = fitScreenOutput(box, w, h);
    return std::pair{out.width, out.height};
  };
  using Size = std::pair<std::uint32_t, std::uint32_t>;
  require(fit(kScreenProfile1080p60, 1920, 1080) == Size{1920, 1080}, "16:9 monitor changed size");
  require(fit(kScreenProfile1080p60, 3440, 1440) == Size{1920, 800}, "ultrawide is not 1920x800");
  require(fit(kScreenProfile1080p60, 1080, 1920) == Size{600, 1080}, "portrait is not 600x1080");
  require(fit(kScreenProfile1080p60, 800, 600) == Size{800, 600}, "small window was upscaled");
  require(fit(kScreenProfile1080p60, 200, 100) == Size{320, 160}, "tiny window not raised to 320");
  require(fit({960, 540, 30, 625'000}, 960, 540) == Size{960, 540}, "540p preset lost its height");
  require(fitScreenOutput(kScreenProfile1080p60, 3440, 1440).bitrate == kScreenProfile1080p60.bitrate,
          "preset bitrate changed");
}

void gpuMarkerMatchesNeutralObserverContract() {
  const auto owner = processD3d11Device(false);
  {
    GpuScreenConverter production(owner, kScreenProfile720p30);
    const auto black = solidBgra(owner, 320, 180, {0, 0, 0, 255});
    const auto clean =
        production.convert({owner, black.Get()}, {7, 1, 320, 180, FramePixelFormat::Bgra8, 3});
    require(clean.has_value(), "production conversion failed");
    require(readMarkerMagic(owner, clean->texture(), 1280, 720) == 0,
            "production conversion painted laboratory marker");
    require(production.stats().texture_bytes == 1280ULL * 720 * 3 / 2 * 3,
            "production allocated a laboratory marker texture");
  }
  GpuScreenConverter converter(owner, kScreenProfile720p30, true);
  const auto source = solidBgra(owner, 320, 180, {0, 0, 0, 255});
  const auto converted =
      converter.convert({owner, source.Get()}, {7, 1, 320, 180, FramePixelFormat::Bgra8, 3});
  require(converted.has_value(), "GPU marker conversion failed");
  require(readMarkerMagic(owner, converted->texture(), kScreenProfile720p30.width,
                          kScreenProfile720p30.height) == kScreenMarkerMagic,
          "GPU marker does not match the neutral observer contract");
}

}  // namespace

int main() try {
  convertsSolidRedWithinBt709Tolerance();
  slotPoolIsFixedAndReturnsReleasedSlots();
  inputViewsDoNotSurviveBackendGenerations();
  oddInputDimensionsUseAnEvenCrop();
  otherAspectRatiosAreLetterboxedNotCropped();
  streamFollowsTheSourceAspectRatio();
  gpuMarkerMatchesNeutralObserverContract();
  syrnike::windows_media::screen::tests::hardwareH264ProbeCoversFixedProfiles();
  syrnike::windows_media::screen::tests::hardwareH264EncoderProducesBoundedAnnexBOutput();
  syrnike::windows_media::screen::tests::hardwareKeyframeRequestAppliesToNextInput();
  syrnike::windows_media::screen::tests::encodedBackpressureKeepsEveryReferenceFrame();
  syrnike::windows_media::screen::tests::
      productionGpuPipelineStartsHardwareBeforePublicationAndStops();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
