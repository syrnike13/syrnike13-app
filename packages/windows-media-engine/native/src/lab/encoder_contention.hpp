#pragma once
#include "lab/bitrate_fixture_pattern.hpp"
#include "screen/hardware_h264_encoder.hpp"
#include <array>
#include <atomic>
#include <memory>
#include <stdexcept>
#include <thread>

namespace syrnike::windows_media::lab {
// Laboratory-only competing hardware encoders. Seven fixed pipelines plus the
// publisher fit within eight sessions. This does not change product presets.
class EncoderContention final {
 public:
  // Explicit texture/output pools only; process diagnostics include MFT/driver
  // allocations as well and must not be replaced by this counter.
  static constexpr std::uint64_t tracked_bytes = 1920ULL * 1080 * 4 * 2 +
      7 * (4096ULL * 4096 * 3 / 2 * screen::kGpuConversionSlotCapacity +
           screen::kEncodedH264SlotCapacity * screen::kEncodedH264SlotBytes);
  explicit EncoderContention(const std::shared_ptr<capture::D3d11DeviceOwner>& device)
      : device_(device) {
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = 1920; desc.Height = 1080; desc.MipLevels = desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    for (std::uint32_t index = 0; index < textures_.size(); ++index) {
      const auto pixels = bitrateFixturePattern(index);
      const D3D11_SUBRESOURCE_DATA data{pixels.data(), 1920 * 4, 0};
      if (FAILED(device_->device()->CreateTexture2D(&desc, &data, &textures_[index])))
        throw std::runtime_error("Encoder contention texture creation failed");
    }
    const screen::ScreenVideoProfile profile{4096, 4096, 60, 64'000'000};
    for (auto& pipeline : pipelines_) {
      pipeline.converter = std::make_unique<screen::GpuScreenConverter>(device_, profile);
      pipeline.encoder = std::make_unique<screen::HardwareH264Encoder>(device_, profile);
      if (pipeline.encoder->start(std::chrono::seconds{5}))
                throw std::runtime_error("Competing hardware encoder unavailable");
    }
    worker_ = std::thread([this] { run(); });
  }
  ~EncoderContention() {
    stop_ = true;
    if (worker_.joinable()) worker_.join();
    for (auto& pipeline : pipelines_)
      if (!pipeline.encoder->stop(std::chrono::seconds{5})) std::terminate();
  }
  void setActive(bool value) noexcept { active_ = value; }
  [[nodiscard]] bool failed() const noexcept { return failed_; }
  [[nodiscard]] std::uint64_t frames() const noexcept { return frames_; }
 private:
  void run() noexcept {
    try {
      std::uint64_t sequence = 0;
      while (!stop_) {
        for (auto& pipeline : pipelines_) {
          while (auto output = pipeline.encoder->takeEncoded()) ++frames_;
          if (pipeline.encoder->failure()) { failed_ = true; return; }
          if (!active_) continue;
          const auto timestamp = screen::screenSteadyTimestamp100ns();
          auto frame = pipeline.converter->convert({device_, textures_[(++sequence) % textures_.size()].Get()},
              {sequence, timestamp, 1920, 1080, capture::FramePixelFormat::Bgra8, 1});
          if (frame) (void)pipeline.encoder->submit(std::move(*frame), timestamp / 10, 16667);
        }
        std::this_thread::sleep_for(std::chrono::milliseconds{1});
      }
    } catch (...) { failed_ = true; }
  }
  struct Pipeline {
    std::unique_ptr<screen::GpuScreenConverter> converter;
    std::unique_ptr<screen::HardwareH264Encoder> encoder;
  };
  std::shared_ptr<capture::D3d11DeviceOwner> device_;
  std::array<Microsoft::WRL::ComPtr<ID3D11Texture2D>, 2> textures_;
  std::array<Pipeline, 7> pipelines_;
  std::atomic_bool active_{false}, stop_{false}, failed_{false};
  std::atomic_uint64_t frames_{0};
  std::thread worker_;
};
}  // namespace syrnike::windows_media::lab
