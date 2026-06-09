#include "microphone_echo_reference.hpp"

#include "audio_constants.hpp"

#include <stdexcept>
#include <string>
#include <vector>

namespace {

void expect(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() {
  syrnike::voice::MicrophoneEchoReferenceBuffer buffer(2);

  std::vector<float> stereo(
    static_cast<std::size_t>(syrnike::voice::kSamplesPer10Ms) * 2
  );
  for (std::size_t frame = 0; frame < syrnike::voice::kSamplesPer10Ms; ++frame) {
    stereo[frame * 2] = 0.5f;
    stereo[frame * 2 + 1] = -0.25f;
  }

  buffer.pushInterleavedFloatStereo(
    stereo.data(),
    syrnike::voice::kSamplesPer10Ms,
    false
  );
  const auto mono = buffer.popFrame();
  expect(mono.has_value(), "buffer should emit a 10ms mono frame");
  expect(mono->size() == syrnike::voice::kSamplesPer10Ms, "mono frame should be 10ms");
  expect((*mono)[0] > 3000, "stereo frame should be downmixed to positive mono");
  expect((*mono)[0] < 5000, "stereo frame should be averaged before PCM conversion");

  buffer.pushInterleavedFloatStereo(stereo.data(), syrnike::voice::kSamplesPer10Ms, false);
  buffer.pushInterleavedFloatStereo(stereo.data(), syrnike::voice::kSamplesPer10Ms, false);
  buffer.pushInterleavedFloatStereo(stereo.data(), syrnike::voice::kSamplesPer10Ms, false);
  expect(buffer.queuedFrames() == 2, "buffer should stay bounded");

  buffer.pushInterleavedFloatStereo(nullptr, syrnike::voice::kSamplesPer10Ms, true);
  expect(buffer.queuedFrames() == 2, "silent frames should still obey queue bound");

  return 0;
}
