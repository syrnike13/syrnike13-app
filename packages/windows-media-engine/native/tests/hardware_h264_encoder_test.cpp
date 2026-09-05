#include <d3d11.h>
#include <wrl/client.h>

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <thread>
#include <vector>

#include "capture/d3d11_device.hpp"
#include "screen/gpu_screen_converter.hpp"
#include "screen/hardware_h264_encoder.hpp"
#include "screen/production_screen_pipeline.hpp"

namespace syrnike::windows_media::screen::tests {
namespace {

using Microsoft::WRL::ComPtr;

ComPtr<ID3D11Texture2D> makeFrame(
    const std::shared_ptr<capture::D3d11DeviceOwner>& owner,
    std::uint32_t width, std::uint32_t height) {
  std::vector<std::uint8_t> pixels(width * height * 4ULL, 0);
  for (std::uint32_t y = 0; y < height; ++y) {
    for (std::uint32_t x = 0; x < width; ++x) {
      const auto offset = (static_cast<std::size_t>(y) * width + x) * 4;
      pixels[offset] = static_cast<std::uint8_t>(x % 255);
      pixels[offset + 1] = static_cast<std::uint8_t>(y % 255);
      pixels[offset + 2] = 160;
      pixels[offset + 3] = 255;
    }
  }
  D3D11_TEXTURE2D_DESC description{};
  description.Width = width;
  description.Height = height;
  description.MipLevels = 1;
  description.ArraySize = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_DEFAULT;
  description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  D3D11_SUBRESOURCE_DATA initial{pixels.data(), width * 4, 0};
  ComPtr<ID3D11Texture2D> texture;
  if (FAILED(owner->device()->CreateTexture2D(&description, &initial,
                                               &texture)))
    throw std::runtime_error("failed to create encoder test frame");
  return texture;
}

}  // namespace

void hardwareH264EncoderProducesBoundedAnnexBOutput() {
  using namespace std::chrono_literals;
  const auto owner = capture::processD3d11Device(false);
  constexpr std::array profiles{kScreenProfile1080p60,
                                kScreenProfile1440p30,
                                kScreenProfile720p30};
  for (const auto profile : profiles) {
    GpuScreenConverter converter(owner, profile);
    HardwareH264Encoder encoder(owner, profile);
    if (const auto failure = encoder.start(5s))
      throw std::runtime_error(failure->message);

    const auto source = makeFrame(owner, profile.width, profile.height);
    capture::FrameMetadata metadata;
    metadata.width = profile.width;
    metadata.height = profile.height;
    const auto duration_us =
        static_cast<std::int64_t>(1'000'000 / profile.frames_per_second);
    encoder.requestKeyFrame();
    for (std::uint64_t sequence = 1; sequence <= 3; ++sequence) {
      metadata.sequence = sequence;
      auto converted = converter.convert({owner, source.Get()}, metadata);
      if (!converted ||
          !encoder.submit(std::move(*converted),
                          static_cast<std::int64_t>(sequence) * duration_us,
                          duration_us))
        throw std::runtime_error("hardware encoder rejected a bounded input");
    }

    std::optional<EncodedH264SlotLease> output;
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    while (!output && std::chrono::steady_clock::now() < deadline) {
      output = encoder.takeEncoded();
      if (!output) std::this_thread::sleep_for(2ms);
    }
    if (!output || output->frame().bytes.empty() ||
        output->frame().bytes.size() > kEncodedH264SlotBytes)
      throw std::runtime_error(
          "hardware encoder produced no bounded H.264 output");
    const auto bytes = output->frame().bytes;
    const bool annex_b =
        bytes.size() >= 4 && bytes[0] == std::byte{0} &&
        bytes[1] == std::byte{0} &&
        ((bytes[2] == std::byte{1}) ||
         (bytes[2] == std::byte{0} && bytes[3] == std::byte{1}));
    if (!annex_b)
      throw std::runtime_error("hardware encoder output is not Annex B H.264");
    const auto stats = encoder.stats();
    if (stats.encoded == 0 || stats.keyframes == 0 ||
        stats.encoded_bytes == 0 ||
        stats.input_slots_in_use > kGpuConversionSlotCapacity ||
        stats.output_slots_in_use > kEncodedH264SlotCapacity ||
        stats.maximum_output_slots_in_use > kEncodedH264SlotCapacity ||
        stats.output_pool_bytes !=
            kEncodedH264SlotCapacity * kEncodedH264SlotBytes)
      throw std::runtime_error("hardware encoder output accounting is invalid");
    output.reset();
    if (!encoder.stop(5s) ||
        encoder.state() != HardwareH264EncoderState::stopped)
      throw std::runtime_error("hardware encoder did not drain and stop");
    const auto converter_stats = converter.stats();
    if (converter_stats.slots_in_use != 0 ||
        converter_stats.gpu_timing_measurements +
                converter_stats.gpu_timing_unavailable +
                converter_stats.gpu_timings_pending ==
            0)
      throw std::runtime_error(
          "GPU conversion completion timing was not collected");
  }
}

namespace {

class ImmediatePublicationAdapter final : public ScreenPublicationAdapter {
 public:
  void startPublish(std::uint64_t generation, ScreenTrackDescriptor,
                    ScreenOperationCompletion completion) override {
    completion(generation, ScreenOperationResult::success());
  }
  void startSubmit(std::uint64_t generation, EncodedScreenFrame,
                   ScreenOperationCompletion completion) override {
    completion(generation, ScreenOperationResult::success());
  }
  void startUnpublish(std::uint64_t generation,
                      ScreenOperationCompletion completion) override {
    completion(generation, ScreenOperationResult::success());
  }
};

}  // namespace

void productionGpuPipelineStartsHardwareBeforePublicationAndStops() {
  using namespace std::chrono_literals;
  const auto owner = capture::processD3d11Device(false);
  for (int cycle = 0; cycle < 30; ++cycle) {
    auto capture_pipeline = std::make_shared<ScreenFramePipeline>();
    ProductionScreenPipeline pipeline(
        owner, capture_pipeline, kScreenProfile720p30,
        [](const std::shared_ptr<HardwareH264Encoder>&) {
          return std::make_shared<ImmediatePublicationAdapter>();
        });
    const auto started = pipeline.start("screen-production", 5s);
    if (!started.ok)
      throw std::runtime_error(started.failure ? started.failure->message
                                               : "production pipeline failed");
    const auto running_deadline = std::chrono::steady_clock::now() + 1s;
    while (pipeline.state() == ProductionScreenPipelineState::starting &&
           std::chrono::steady_clock::now() < running_deadline)
      std::this_thread::sleep_for(1ms);
    if (pipeline.state() != ProductionScreenPipelineState::running)
      throw std::runtime_error(
          "production pipeline did not observe publication");
    const auto stats = pipeline.stats();
    if (stats.encoder_implementation.empty())
      throw std::runtime_error(
          "production pipeline omitted encoder diagnostics");
    const auto stopped =
        pipeline.stop(std::chrono::steady_clock::now() + 5s);
    if (!stopped.ok ||
        pipeline.state() != ProductionScreenPipelineState::stopped)
      throw std::runtime_error(
          stopped.failure ? stopped.failure->message
                          : "production pipeline did not stop");
  }
}

}  // namespace syrnike::windows_media::screen::tests
