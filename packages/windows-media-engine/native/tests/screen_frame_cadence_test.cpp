#include "screen/screen_frame_cadence.hpp"
#include <stdexcept>
#include <iostream>
using syrnike::windows_media::screen::ScreenFrameCadence;
int main() {
  try {
    for (const int source_fps : {30, 60, 75, 120, 144, 240}) {
      ScreenFrameCadence cadence;
      int delivered = 0;
      for (int frame = 0; frame < source_fps * 60; ++frame) {
        const auto time = 1'000'000LL + frame * 1'000'000LL / source_fps + (frame % 2 ? 300 : -300);
        if (cadence.due(time, 16'666)) {
          cadence.accepted(time, 16'666);
          ++delivered;
        }
      }
      const int expected = (source_fps < 60 ? source_fps : 60) * 60;
      if (delivered < expected - 1 || delivered > expected + 1)
        throw std::runtime_error("cadence lost source frames or exceeded 60 Hz budget");
    }
    ScreenFrameCadence cadence;
    cadence.accepted(1'000'000, 16'666);
    if (!cadence.due(5'000'000, 16'666))
      throw std::runtime_error("static gap blocked fresh capture");
    cadence.accepted(5'000'000, 16'666);
    if (cadence.due(5'001'000, 16'666))
      throw std::runtime_error("static gap caused catch-up burst");
    std::cout << "Screen frame cadence passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
