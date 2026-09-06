#include "screen/hardware_h264_encoder.hpp"
#include "lab/bitrate_fixture_pattern.hpp"
#include <wrl/client.h>
#include <array>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace syrnike::windows_media;
using namespace syrnike::windows_media::screen;
using namespace std::chrono_literals;
int main(int argc, char** argv) {
  try {
    auto owner = capture::processD3d11Device(false);
    auto profile = kScreenProfile1080p60;
    if (argc > 1) profile.bitrate = static_cast<std::uint32_t>(std::stoul(argv[1]));
    const auto segment_seconds = argc > 2 ? std::stoul(argv[2]) : 20UL;
    if (segment_seconds < 1 || segment_seconds > 60) throw std::runtime_error("invalid duration");
    GpuScreenConverter converter(owner, profile);
    HardwareH264Encoder encoder(owner, profile);
    if (auto failure = encoder.start(5s)) throw std::runtime_error(failure->message);
    std::cout << "encoder=" << encoder.transformName() << std::endl;
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = 1920; desc.Height = 1080; desc.MipLevels = desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    // Eight deterministic, spatially detailed moving fixture frames.
    std::array<Microsoft::WRL::ComPtr<ID3D11Texture2D>, 8> textures;
    for (std::uint32_t phase = 0; phase < textures.size(); ++phase) {
      const auto pixels = lab::bitrateFixturePattern(phase);
      D3D11_SUBRESOURCE_DATA data{pixels.data(), 1920 * 4, 0};
      if (FAILED(owner->device()->CreateTexture2D(&desc, &data, &textures[phase])))
        throw std::runtime_error("fixture texture creation failed");
    }
    std::uint64_t sequence = 0;
    const std::array rates{profile.bitrate, profile.bitrate / 2, profile.bitrate / 4,
                          profile.bitrate / 2, profile.bitrate / 4, profile.bitrate / 2};
    std::array<std::uint64_t, rates.size()> measured{};
    const auto instance = encoder.stats().instance_id;
    encoder.requestKeyFrame();
    for (std::size_t segment = 0; segment < rates.size(); ++segment) {
      if (segment && !encoder.requestBitrate(segment, rates[segment]))
        throw std::runtime_error("bitrate command rejected at admission");
      const auto start = std::chrono::steady_clock::now();
      const auto before = encoder.stats();
      auto next = start;
      while (std::chrono::steady_clock::now() - start < std::chrono::seconds(segment_seconds)) {
        while (encoder.takeEncoded()) {}
        if (auto failure = encoder.failure()) throw std::runtime_error(failure->message);
        if (std::chrono::steady_clock::now() >= next) {
          ++sequence;
          auto frame = converter.convert({owner, textures[sequence % textures.size()].Get()},
              {sequence, 1, 1920, 1080, capture::FramePixelFormat::Bgra8, 1});
          if (frame) (void)encoder.submit(std::move(*frame), sequence * 16667, 16667);
          next += 16667us;
        }
        std::this_thread::sleep_for(1ms);
      }
      const auto result = encoder.bitrateUpdate();
      const auto after = encoder.stats();
      measured[segment] = (after.encoded_bytes - before.encoded_bytes) * 8 / segment_seconds;
      std::cout << "segment=" << segment << " requested=" << rates[segment]
                << " applied=" << result.applied_bitrate << " outcome=" << int(result.outcome)
                << " hr=" << result.platform_result << " measured_bps="
                << measured[segment]
                << " frames=" << after.encoded - before.encoded
                << " keyframes=" << after.keyframes - before.keyframes
                << " instance=" << after.instance_id << std::endl;
      if (after.instance_id != instance || result.applied_bitrate != rates[segment] ||
          (segment && result.outcome != BitrateUpdateOutcome::applied))
        throw std::runtime_error("live result/identity failed");
      // Full 20-second windows include the control transition. The initial
      // 8Mbps stage may underfill this fixture; every later 2/4Mbps stage must
      // track within 30%, and each down/up must change measured output by 40%.
      if (segment_seconds >= 20 && segment &&
          (measured[segment] < rates[segment] * 7ULL / 10 ||
           measured[segment] > rates[segment] * 13ULL / 10))
        throw std::runtime_error("bitstream outside declared 30% tolerance");
      if (segment_seconds >= 20 && segment >= 2 &&
          (rates[segment] > rates[segment - 1]
            ? measured[segment] * 10 < measured[segment - 1] * 14
            : measured[segment - 1] * 10 < measured[segment] * 14))
        throw std::runtime_error("bitstream did not respond by 40%");
    }
    while (encoder.takeEncoded()) {}
    if (!encoder.stop(5s)) throw std::runtime_error("stop failed");
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
