// Hardware lab: how a real H.264 MFT follows frequent live bitrate updates.
// Not a ctest: it needs a hardware encoder and runs for about a minute.
#include <d3d11.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>
#include <iostream>
#include <iomanip>
#include <random>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "capture/d3d11_device.hpp"
#include "screen/gpu_screen_converter.hpp"
#include "screen/hardware_h264_encoder.hpp"

using namespace syrnike::windows_media;
using namespace syrnike::windows_media::screen;
using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;

namespace {

// Screen-like content: static gradient with a moving high-detail band, so the
// encoder has real work every frame without being pure noise.
std::vector<ComPtr<ID3D11Texture2D>> makeFrames(
    const std::shared_ptr<capture::D3d11DeviceOwner>& owner, std::uint32_t width,
    std::uint32_t height, std::size_t count, std::uint32_t band_divisor) {
  std::mt19937 random(13);
  std::vector<ComPtr<ID3D11Texture2D>> frames;
  std::vector<std::uint8_t> pixels(width * height * 4ULL);
  for (std::size_t index = 0; index < count; ++index) {
    const auto band_top = static_cast<std::uint32_t>(index * height / count);
    for (std::uint32_t y = 0; y < height; ++y) {
      const bool band = y >= band_top && y < band_top + height / band_divisor;
      for (std::uint32_t x = 0; x < width; ++x) {
        const auto offset = (static_cast<std::size_t>(y) * width + x) * 4;
        if (band) {
          const auto value = random();
          pixels[offset] = static_cast<std::uint8_t>(value);
          pixels[offset + 1] = static_cast<std::uint8_t>(value >> 8);
          pixels[offset + 2] = static_cast<std::uint8_t>(value >> 16);
        } else {
          pixels[offset] = static_cast<std::uint8_t>(x * 255 / width);
          pixels[offset + 1] = static_cast<std::uint8_t>(y * 255 / height);
          pixels[offset + 2] = 96;
        }
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
    if (FAILED(owner->device()->CreateTexture2D(&description, &initial, &texture)))
      throw std::runtime_error("failed to create lab frame");
    frames.push_back(texture);
  }
  return frames;
}

struct Step {
  double at_s;
  std::uint32_t bitrate;
};

struct Window {
  std::uint64_t bytes = 0, frames = 0, keyframes = 0;
};

}  // namespace

int main(int argc, char** argv) {
  const bool step_response = argc > 1 && std::string_view(argv[1]) == "step";
  try {
    const auto profile = kScreenProfile1080p60;
    const auto owner = capture::processD3d11Device(false);
    GpuScreenConverter converter(owner, profile);
    HardwareH264Encoder encoder(owner, profile);
    if (const auto failure = encoder.start(std::chrono::seconds{5}))
      throw std::runtime_error(failure->message);
    std::cout << "encoder: " << encoder.transformName() << "\n";
    // argv[2]: share of the frame that is high-detail, as 1/N (default 1/10).
    const auto band_divisor = argc > 2 ? static_cast<std::uint32_t>(std::stoul(argv[2])) : 10U;
    const auto frames = makeFrames(owner, profile.width, profile.height, 24, band_divisor);

    // Phase A: steady 8M. B: one change per second. C: four per second.
    // D: follow-the-budget ramp 2M -> 8M in 0.5M steps every second.
    std::vector<Step> steps;
    double t = 4;
    if (step_response) {
      // Hold each target long enough to see how fast rate control converges.
      for (const auto mbps : {2.0, 8.0, 4.0, 8.0, 3.0})
        steps.push_back({t, static_cast<std::uint32_t>(mbps * 1e6)}), t += 6;
    } else {
      for (const auto mbps : {5.0, 3.0, 6.5, 8.0, 4.0, 7.0, 2.0, 8.0, 5.5, 7.5, 3.5, 6.0})
        steps.push_back({t, static_cast<std::uint32_t>(mbps * 1e6)}), t += 1;
      for (int i = 0; i < 32; ++i)
        steps.push_back({t, i % 2 ? 7'000'000U : 4'000'000U}), t += 0.25;
      for (std::uint32_t bitrate = 2'000'000; bitrate <= 8'000'000; bitrate += 500'000)
        steps.push_back({t, bitrate}), t += 1;
    }
    const double end_s = t + 3;

    const auto begin = Clock::now();
    const auto seconds = [&] { return std::chrono::duration<double>(Clock::now() - begin).count(); };
    std::vector<Window> windows(static_cast<std::size_t>(end_s * 4) + 1);  // 250 ms windows
    std::size_t next_step = 0;
    std::uint64_t revision = 0, sequence = 0, rejected_inputs = 0;
    std::vector<double> apply_latency_ms;
    double requested_at = 0;
    bool awaiting = false;
    std::uint32_t current = profile.bitrate;
    std::vector<std::uint32_t> target_at(windows.size(), profile.bitrate);
    // argv[3]: input frames per second; the encoder stays configured for the
    // preset rate, and each input keeps the preset's nominal duration, as the
    // production pipeline submits frames when it admits fewer captures.
    const auto input_fps = argc > 3 ? static_cast<std::uint32_t>(std::stoul(argv[3]))
                                    : profile.frames_per_second;
    const auto interval = std::chrono::microseconds(1'000'000 / input_fps);
    const auto nominal_us = static_cast<std::int64_t>(1'000'000 / profile.frames_per_second);
    std::cout << "input fps: " << input_fps << "\n";
    auto next_frame = Clock::now();

    encoder.requestKeyFrame();
    while (seconds() < end_s) {
      const auto now_s = seconds();
      if (next_step < steps.size() && now_s >= steps[next_step].at_s) {
        if (!encoder.requestBitrate(++revision, steps[next_step].bitrate))
          throw std::runtime_error("bitrate request refused at step " + std::to_string(next_step));
        current = steps[next_step].bitrate;
        requested_at = now_s;
        awaiting = true;
        ++next_step;
      }
      const auto update = encoder.bitrateUpdate();
      if (awaiting && update.revision == revision &&
          update.outcome != BitrateUpdateOutcome::pending) {
        if (update.outcome != BitrateUpdateOutcome::applied)
          throw std::runtime_error("bitrate update outcome " +
                                   std::to_string(static_cast<int>(update.outcome)) +
                                   " platform " + std::to_string(update.platform_result));
        apply_latency_ms.push_back((now_s - requested_at) * 1000);
        awaiting = false;
      }
      const auto window_index = static_cast<std::size_t>(now_s * 4);
      if (window_index < target_at.size()) target_at[window_index] = current;

      if (Clock::now() >= next_frame) {
        next_frame += interval;
        ++sequence;
        const auto& texture = frames[sequence % frames.size()];
        capture::FrameMetadata metadata;
        metadata.sequence = sequence;
        metadata.width = profile.width;
        metadata.height = profile.height;
        auto converted = converter.convert({owner, texture.Get()}, metadata);
        const auto timestamp = static_cast<std::int64_t>(sequence) * interval.count();
        if (!converted || !encoder.submit(std::move(*converted), timestamp, nominal_us))
          ++rejected_inputs;
      }
      while (auto output = encoder.takeEncoded()) {
        auto& window = windows[(std::min)(window_index, windows.size() - 1)];
        window.bytes += output->frame().bytes.size();
        ++window.frames;
        if (output->frame().keyframe) ++window.keyframes;
      }
      if (encoder.failure()) throw std::runtime_error(encoder.failure()->message);
      std::this_thread::sleep_for(std::chrono::milliseconds{1});
    }

    // One-second sliding report aligned to whole seconds, plus phase summaries.
    std::cout << std::fixed << std::setprecision(2);
    if (step_response) {
      std::cout << "  t(s)  target  actual(250ms windows, Mbit/s)\n";
      for (std::size_t q = 0; q + 4 < windows.size(); ++q)
        std::cout << std::setw(6) << q / 4.0 << std::setw(8) << target_at[q] / 1e6
                  << std::setw(8) << windows[q].bytes * 32.0 / 1e6
                  << (windows[q].keyframes ? "  K" : "") << "\n";
    }
    std::cout << "  t(s)  target  actual  ratio  fps  keyframes\n";
    for (std::size_t second = 0; second + 1 < static_cast<std::size_t>(end_s); ++second) {
      Window sum;
      double target_sum = 0;
      for (std::size_t q = 0; q < 4; ++q) {
        const auto& w = windows[second * 4 + q];
        sum.bytes += w.bytes, sum.frames += w.frames, sum.keyframes += w.keyframes;
        target_sum += target_at[second * 4 + q];
      }
      const auto target = target_sum / 4;
      const auto actual = sum.bytes * 8.0;
      std::cout << std::setw(6) << second << std::setw(8) << target / 1e6 << std::setw(8)
                << actual / 1e6 << std::setw(7) << actual / target << std::setw(5)
                << sum.frames << std::setw(6) << sum.keyframes << "\n";
    }
    double maximum_latency = 0, total_latency = 0;
    for (const auto value : apply_latency_ms)
      maximum_latency = (std::max)(maximum_latency, value), total_latency += value;
    const auto stats = encoder.stats();
    std::cout << "updates applied: " << apply_latency_ms.size() << "/" << steps.size()
              << ", apply latency avg " << total_latency / (std::max<std::size_t>)(1, apply_latency_ms.size())
              << " ms, max " << maximum_latency << " ms\n"
              << "submitted " << stats.submitted << ", encoded " << stats.encoded
              << ", keyframes " << stats.keyframes << ", rejected inputs " << rejected_inputs
              << ", input superseded " << stats.input_superseded
              << ", output superseded " << stats.output_superseded
              << ", output stalls " << stats.output_stalls << "\n";
    if (!encoder.stop(std::chrono::seconds{5})) throw std::runtime_error("encoder stop failed");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "lab failed: " << error.what() << "\n";
    return 1;
  }
}
