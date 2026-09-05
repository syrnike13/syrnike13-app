#pragma once
#include "audio/screen_audio_pcm.hpp"
#include <cmath>
#include <iomanip>
#include <iostream>

namespace syrnike::windows_media::lab {
// Fixture-only DSP on the publication worker. No processing is added to the
// Windows capture callback. Emits one reference for each complete coded pulse.
class AudioPulseRecorder {
 public:
  void observe(const audio::PcmPacket& packet) {
    double squares = 0;
    for (std::size_t i = 0; i < audio::kAudioPacketFrames; ++i) {
      const double sample = packet.samples[i * 2];
      squares += sample * sample;
    }
    const double rms = std::sqrt(squares / audio::kAudioPacketFrames);
    if (rms > 200) {
      if (!active_) {
        active_ = true;
        timestamp_ = packet.capture_timestamp_100ns;
        best_rms_ = 0;
      }
      if (rms <= best_rms_) return;
      best_rms_ = rms;
      double maximum = 0;
      for (unsigned code = 0; code < 16; ++code) {
        const double coefficient =
            2 * std::cos(2 * 3.14159265358979323846 * (600 + code * 100) / audio::kAudioRate);
        double a = 0, b = 0;
        for (std::size_t i = 0; i < audio::kAudioPacketFrames; ++i) {
          const double next = packet.samples[i * 2] + coefficient * a - b;
          b = a;
          a = next;
        }
        const double energy = a * a + b * b - coefficient * a * b;
        if (energy > maximum) {
          maximum = energy;
          code_ = code;
        }
      }
    } else if (rms < 100 && active_) {
      active_ = false;
      std::cout << "CODED_AUDIO_CAPTURE {\"atMs\":" << std::setprecision(17)
                << static_cast<double>(timestamp_) / 10000.0 << ",\"code\":" << code_
                << ",\"rms\":" << best_rms_ << "}" << std::endl;
    }
  }

 private:
  bool active_ = false;
  double best_rms_ = 0;
  unsigned code_ = 0;
  std::int64_t timestamp_ = 0;
};
}  // namespace syrnike::windows_media::lab
