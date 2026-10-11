#include <d3d11.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "capture/d3d11_device.hpp"
#include "screen/gpu_screen_converter.hpp"
#include "screen/hardware_h264_encoder.hpp"
#include "screen/production_screen_pipeline.hpp"
#include "video/hardware_video_decoder.hpp"

namespace {

using namespace syrnike::windows_media;
using Microsoft::WRL::ComPtr;
using namespace std::chrono_literals;
using AccessUnit = std::vector<std::uint8_t>;
using Result = video::HardwareVideoDecoder::Result;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

ComPtr<ID3D11Texture2D> solidFrame(const std::shared_ptr<capture::D3d11DeviceOwner>& owner,
                                   std::uint32_t width, std::uint32_t height) {
  // R 200, G 120, B 40: a color that survives 4:2:0 and limited range.
  std::vector<std::uint32_t> pixels(std::size_t{width} * height, 0xffc87828U);
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width;
  desc.Height = height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  D3D11_SUBRESOURCE_DATA initial{pixels.data(), width * 4, 0};
  ComPtr<ID3D11Texture2D> texture;
  require(SUCCEEDED(owner->device()->CreateTexture2D(&desc, &initial, &texture)),
          "test frame allocation failed");
  return texture;
}

// Hardware-encoded H.264 of a solid frame: a keyframe, then deltas.
std::vector<AccessUnit> encode(screen::ScreenVideoProfile profile, int frames) {
  const auto owner = capture::processD3d11Device(false);
  screen::GpuScreenConverter converter(owner, profile);
  screen::HardwareH264Encoder encoder(owner, profile);
  if (const auto failure = encoder.start(5s)) throw std::runtime_error(failure->message);
  const auto source = solidFrame(owner, profile.width, profile.height);
  capture::FrameMetadata metadata;
  metadata.width = profile.width;
  metadata.height = profile.height;
  const auto duration_us = static_cast<std::int64_t>(1'000'000 / profile.frames_per_second);
  encoder.requestKeyFrame();
  std::vector<AccessUnit> units;
  for (int sequence = 1; sequence <= frames; ++sequence) {
    metadata.sequence = static_cast<std::uint64_t>(sequence);
    auto converted = converter.convert({owner, source.Get()}, metadata);
    require(converted && encoder.submit(std::move(*converted), sequence * duration_us,
                                        duration_us),
            "encoder rejected input");
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    while (std::chrono::steady_clock::now() < deadline) {
      if (auto output = encoder.takeEncoded()) {
        const auto bytes = output->frame().bytes;
        units.emplace_back(reinterpret_cast<const std::uint8_t*>(bytes.data()),
                           reinterpret_cast<const std::uint8_t*>(bytes.data()) + bytes.size());
        break;
      }
      std::this_thread::sleep_for(1ms);
    }
  }
  require(encoder.stop(5s), "encoder did not stop");
  require(units.size() == static_cast<std::size_t>(frames), "encoder lost frames");
  return units;
}

// Decodes every unit; returns the frames produced, newest last.
std::vector<std::shared_ptr<video::DecodedVideoFrame>> decodeAll(
    video::HardwareVideoDecoder& decoder, const std::vector<AccessUnit>& units) {
  std::vector<std::shared_ptr<video::DecodedVideoFrame>> frames;
  for (std::size_t index = 0; index < units.size(); ++index) {
    std::shared_ptr<video::DecodedVideoFrame> frame;
    const auto result = decoder.decode(units[index], index == 0, frame);
    require(result == Result::Frame || result == Result::NoFrame,
            "decoder failed on a valid stream");
    if (frame) frames.push_back(std::move(frame));
  }
  return frames;
}

void requireColor(const video::DecodedVideoFrame& frame) {
  std::vector<std::uint8_t> y(std::size_t{frame.width} * frame.height);
  std::vector<std::uint8_t> u(y.size() / 4 + frame.width), v(u.size());
  require(video::readDecodedFrameI420(frame, y.data(), static_cast<int>(frame.width), u.data(),
                                      static_cast<int>(frame.width / 2), v.data(),
                                      static_cast<int>(frame.width / 2)),
          "readback failed");
  // BT.709 limited of R 200, G 120, B 40: Y 129, U 84, V 166.
  const auto center = std::size_t{frame.height / 2} * frame.width + frame.width / 2;
  const auto chroma = std::size_t{frame.height / 4} * (frame.width / 2) + frame.width / 4;
  const auto close = [](int value, int expected) { return std::abs(value - expected) <= 10; };
  require(close(y[center], 129) && close(u[chroma], 84) && close(v[chroma], 166),
          "decoded color is wrong: Y " + std::to_string(y[center]) + " U " +
              std::to_string(u[chroma]) + " V " + std::to_string(v[chroma]));
  // The bottom row lies inside the visible area, not the 1088-line coded padding.
  const auto last = std::size_t{frame.height - 1} * frame.width + frame.width / 2;
  require(close(y[last], 129), "visible area is cropped incorrectly");
}

std::unique_ptr<video::HardwareVideoDecoder> decoder() {
  auto created = video::HardwareVideoDecoder::createH264();
  require(created != nullptr, "no DXVA H.264 decoder on this machine");
  return created;
}

void decodesHardwareH264OnTheGpu() {
  auto instance = decoder();
  const auto frames = decodeAll(*instance, encode(screen::kScreenProfile1080p60, 8));
  require(frames.size() >= 6, "low-latency decoding withheld frames");
  require(frames.back()->width == 1920 && frames.back()->height == 1080,
          "decoded size ignores the display aperture");
  requireColor(*frames.back());
}

void followsAResolutionChangeOnTheSameDecoder() {
  auto instance = decoder();
  auto first = decodeAll(*instance, encode(screen::kScreenProfile720p30, 3));
  require(!first.empty() && first.back()->width == 1280 && first.back()->height == 720,
          "first stream size");
  auto second = decodeAll(*instance, encode(screen::kScreenProfile1080p60, 3));
  require(!second.empty() && second.back()->width == 1920 && second.back()->height == 1080,
          "resized stream size");
  requireColor(*second.back());
  // A frame of the old size outlives the change and is released safely.
  first.clear();
}

void recoversFromCorruptInputAtTheNextKeyframe() {
  auto instance = decoder();
  const auto units = encode(screen::kScreenProfile720p30, 2);
  std::shared_ptr<video::DecodedVideoFrame> frame;
  const AccessUnit garbage(4096, 0x5a);
  const auto corrupt = instance->decode(garbage, false, frame);
  require(corrupt != Result::Fallback && corrupt != Result::Frame, "garbage produced a picture");
  require(!decodeAll(*instance, units).empty(), "decoder did not recover at a keyframe");
}

void heldFramesBoundTheDecoderAndSurviveIt() {
  auto instance = decoder();
  const auto units = encode(screen::kScreenProfile720p30, 12);
  std::vector<std::shared_ptr<video::DecodedVideoFrame>> held;
  bool dropped = false;
  for (std::size_t index = 0; index < units.size(); ++index) {
    std::shared_ptr<video::DecodedVideoFrame> frame;
    const auto result = instance->decode(units[index], index == 0, frame);
    if (frame) held.push_back(std::move(frame));
    dropped = dropped || (result == Result::NoFrame && held.size() >= 8);
  }
  require(held.size() == 8 && dropped, "outstanding frames are not bounded");
  instance.reset();
  requireColor(*held.back());
  held.clear();
}

}  // namespace

int main() {
  const std::pair<const char*, void (*)()> tests[] = {
      {"decodesHardwareH264OnTheGpu", decodesHardwareH264OnTheGpu},
      {"followsAResolutionChangeOnTheSameDecoder", followsAResolutionChangeOnTheSameDecoder},
      {"recoversFromCorruptInputAtTheNextKeyframe", recoversFromCorruptInputAtTheNextKeyframe},
      {"heldFramesBoundTheDecoderAndSurviveIt", heldFramesBoundTheDecoderAndSurviveIt},
  };
  int failures = 0;
  for (const auto& [name, test] : tests) {
    try {
      test();
      std::cout << "PASS " << name << "\n";
    } catch (const std::exception& error) {
      ++failures;
      std::cout << "FAIL " << name << ": " << error.what() << "\n";
    }
  }
  return failures == 0 ? 0 : 1;
}
