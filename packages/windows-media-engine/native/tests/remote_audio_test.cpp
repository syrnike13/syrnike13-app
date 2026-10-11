#include "audio/remote_audio_mix.hpp"
#include "audio/remote_speaker_activity.hpp"

#include <iostream>
#include <stdexcept>

using namespace syrnike::windows_media::audio;
namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
RemoteAudioFrame filled(std::int16_t sample) {
  RemoteAudioFrame frame;
  frame.fill(sample);
  return frame;
}
void jitterPrimesTrimsAndRecovers() {
  RemoteAudioJitter jitter;
  jitter.push(filled(1));
  require(!jitter.pop(), "Jitter buffer played before priming two frames");
  jitter.push(filled(2));
  const auto* first = jitter.pop();
  require(first && (*first)[0] == 1, "Primed jitter buffer reordered frames");
  require(jitter.pop() && !jitter.pop() && jitter.stats().underruns == 1, "Underrun was not counted");
  jitter.push(filled(3));
  require(!jitter.pop(), "Jitter buffer did not re-prime after an underrun");
  for (std::int16_t value = 4; value < 4 + static_cast<std::int16_t>(RemoteAudioJitter::kCapacity) + 2; ++value)
    jitter.push(filled(value));
  require(jitter.stats().overruns == 3, "Full jitter buffer did not drop the oldest frames");
  const auto* trimmed = jitter.pop();
  require(trimmed && jitter.stats().depth == RemoteAudioJitter::kTrim - 1 && jitter.stats().trimmed == 5,
          "Clock drift backlog was not trimmed back to the target depth");
  require((*trimmed)[0] == 11, "Trim did not keep the newest audio");
}
void mixVolumesMuteAndDeafen() {
  RemoteAudioJitter left, right;
  for (int index = 0; index < 4; ++index) {
    left.push(filled(1000));
    right.push(filled(2000));
  }
  RemoteAudioMixer mixer;
  RemoteAudioFrame output;
  std::array<RemoteAudioMixInput, 2> inputs{{{&left, 0.5f, false}, {&right, 1.0f, false}}};
  require(mixer.mix(inputs, false, output) && output[0] == 2500, "Participant volumes were not applied");
  inputs[1].muted = true;
  require(mixer.mix(inputs, false, output) && output[0] == 500, "Muted participant leaked into the mix");
  require(!mixer.mix(inputs, true, output) && output[0] == 0, "Deafen leaked audio");
  require(left.stats().played == 3 && right.stats().played == 3, "Muted or deafened inputs built a backlog");
}
void mixControlsMatchRoomIdentitiesByUser() {
  require(voiceUserId("voice:v1|windows_native|desktop-1|epoch|operation|user-1") == "user-1",
          "Listener controls did not match a native Room identity by user");
  require(voiceUserId("voice:v1|web|tab-1|epoch|operation|user-2") == "user-2",
          "Listener controls did not match a web Room identity by user");
  require(voiceUserId("legacy-user") == "legacy-user", "A plain identity was rewritten");
}
void limiterPreventsClipping() {
  RemoteAudioJitter a, b;
  for (int index = 0; index < 4; ++index) {
    a.push(filled(30000));
    b.push(filled(30000));
  }
  RemoteAudioMixer mixer;
  RemoteAudioFrame output;
  std::array<RemoteAudioMixInput, 2> inputs{{{&a, 1.0f, false}, {&b, 1.0f, false}}};
  require(mixer.mix(inputs, false, output) && output[0] > 30000 && output[0] <= 32112,
          "Two loud speakers clipped instead of being limited");
}
void receivedSpeechActivity() {
  RemoteSpeakerActivity activity;
  const auto start = RemoteSpeakerActivity::Clock::now();
  RemoteAudioFrame quiet = filled(20);
  activity.observe(quiet, start);
  require(!activity.speaking(start), "Quiet decoded PCM marked a remote speaker active");
  activity.observe(filled(1'000), start + std::chrono::milliseconds{10});
  require(activity.speaking(start + std::chrono::milliseconds{10}),
          "Decoded remote speech did not activate the indicator");
  activity.observe(quiet, start + std::chrono::milliseconds{20});
  require(activity.speaking(start + std::chrono::milliseconds{290}),
          "Silence cleared the indicator between syllables");
  require(!activity.speaking(start + std::chrono::milliseconds{310}),
          "Remote indicator survived missing or silent PCM");
}
}  // namespace
int main() try {
  jitterPrimesTrimsAndRecovers();
  mixVolumesMuteAndDeafen();
  mixControlsMatchRoomIdentitiesByUser();
  limiterPreventsClipping();
  receivedSpeechActivity();
  std::cout << "Remote audio contracts passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
