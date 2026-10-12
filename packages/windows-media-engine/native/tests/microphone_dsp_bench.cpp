#include "audio/livekit_microphone_dsp.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

using namespace syrnike::windows_media::audio;
namespace {
std::vector<std::int16_t> readWave(const char* path) {
  std::ifstream stream(path, std::ios::binary);
  std::array<char, 12> header{};
  stream.read(header.data(), header.size());
  if (!stream || std::string(header.data(), 4) != "RIFF" || std::string(header.data() + 8, 4) != "WAVE")
    throw std::runtime_error("Expected a PCM WAV input");
  bool format_valid = false;
  while (stream) {
    std::array<char, 4> name{};
    std::uint32_t size = 0;
    stream.read(name.data(), name.size());
    stream.read(reinterpret_cast<char*>(&size), sizeof(size));
    if (!stream) break;
    if (std::string(name.data(), 4) == "fmt ") {
      std::array<std::uint16_t, 8> format{};
      if (size < sizeof(format)) throw std::runtime_error("Invalid WAV format chunk");
      stream.read(reinterpret_cast<char*>(format.data()), sizeof(format));
      format_valid = format[0] == 1 && format[1] == 1 && format[2] == 48000 && format[3] == 0 && format[7] == 16;
      stream.seekg(size - sizeof(format) + size % 2, std::ios::cur);
    } else if (std::string(name.data(), 4) == "data") {
      if (!format_valid || size % sizeof(std::int16_t)) throw std::runtime_error("Expected 48 kHz mono PCM16");
      std::vector<std::int16_t> samples(size / sizeof(std::int16_t));
      stream.read(reinterpret_cast<char*>(samples.data()), size);
      if (!stream) throw std::runtime_error("Truncated WAV data");
      return samples;
    } else {
      stream.seekg(static_cast<std::streamoff>(size) + size % 2, std::ios::cur);
    }
  }
  throw std::runtime_error("Missing WAV data");
}
struct Level {
  double energy = 0;
  std::size_t count = 0;
  void add(std::int16_t sample) {
    const double value = sample / 32768.0;
    energy += value * value;
    ++count;
  }
  double dbfs() const {
    if (!count) throw std::runtime_error("Region mask contains no measurement samples");
    return energy > 0 ? 10.0 * std::log10(energy / static_cast<double>(count)) : -120.0;
  }
};
}

int main(int argc, char** argv) {
  try {
    if (argc != 4 || (std::string(argv[3]) != "on" && std::string(argv[3]) != "off"))
      throw std::runtime_error("Usage: microphone_dsp_bench input.wav regions.bin on|off");
    const auto samples = readWave(argv[1]);
    std::ifstream mask_stream(argv[2], std::ios::binary);
    // One label per 10 ms: 0=exclude transitions, 1=voiced, 2=settled pause.
    const std::vector<char> regions((std::istreambuf_iterator<char>(mask_stream)), std::istreambuf_iterator<char>());
    if (samples.size() % kMicrophoneFrameSamples || regions.size() != samples.size() / kMicrophoneFrameSamples)
      throw std::runtime_error("Region mask must match complete 10 ms frames");
    MicrophoneDsp dsp(makeLiveKitMicrophoneEnhancement());
    MicrophoneDspConfig config;
    config.echo_cancellation = false;
    config.gate_enabled = std::string(argv[3]) == "on";
    if (!dsp.configure(1, config)) throw std::runtime_error("DSP configuration failed");
    Level speech, noise;
    int peak = 0;
    std::size_t clipped = 0;
    for (std::size_t index = 0; index < regions.size(); ++index) {
      MicrophoneFrame frame;
      std::copy_n(samples.begin() + index * kMicrophoneFrameSamples, kMicrophoneFrameSamples, frame.samples.begin());
      dsp.process(frame, static_cast<std::int64_t>(index + 1) * 100'000, nullptr);
      if (dsp.stats().echo == EchoAvailability::failed) throw std::runtime_error("LiveKit enhancement failed");
      for (const auto sample : frame.samples) {
        const int magnitude = std::abs(static_cast<int>(sample));
        peak = (std::max)(peak, magnitude);
        if (magnitude >= 32111) ++clipped;
        if (regions[index] == 1) speech.add(sample);
        if (regions[index] == 2) noise.add(sample);
      }
    }
    std::cout << std::fixed << std::setprecision(4)
              << "{\"speech_dbfs\":" << speech.dbfs() << ",\"pause_dbfs\":" << noise.dbfs()
              << ",\"peak\":" << peak / 32768.0 << ",\"limited_samples\":" << clipped
              << ",\"speech_samples\":" << speech.count << ",\"pause_samples\":" << noise.count << "}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
