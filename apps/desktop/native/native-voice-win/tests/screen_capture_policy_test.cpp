#include "../src/screen_video_capture.hpp"

#include <cassert>

int main() {
  using namespace syrnike::voice;

  ScreenCaptureFrameResult result;
  assert(result.status == ScreenCaptureFrameStatus::NoFrame);
  assert(result.metrics.output_width == 0);
  assert(result.metrics.output_height == 0);
  assert(result.metrics.hresult == 0);

  return 0;
}
