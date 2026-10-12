#include "screen/screen_encoded_continuity.hpp"
#include <iostream>
#include <stdexcept>
using namespace syrnike::windows_media::screen;
int main() {
  try {
    ScreenEncodedContinuity continuity;
    const auto check = [&](bool keyframe, std::uint64_t age, EncodedFrameAdmission expected) {
      if (continuity.admit(keyframe, age) != expected)
        throw std::runtime_error("Encoded GOP continuity violated");
    };
    check(false, 10, EncodedFrameAdmission::missing_reference);
    check(true, 10, EncodedFrameAdmission::publish);
    check(false, 150'000, EncodedFrameAdmission::publish);
    check(false, 150'001, EncodedFrameAdmission::stale);
    for (int i = 0; i < 120; ++i) check(false, 20, EncodedFrameAdmission::missing_reference);
    check(true, 200'000, EncodedFrameAdmission::stale);
    check(false, 20, EncodedFrameAdmission::missing_reference);
    check(true, 20, EncodedFrameAdmission::publish);
    check(false, 20, EncodedFrameAdmission::publish);
    continuity = {};
    check(false, 20, EncodedFrameAdmission::missing_reference);
    std::cout << "Encoded reference continuity passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
