#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>

namespace livekit { class Track; }

namespace syrnike::desktop_native::media {

struct RemoteAudioSettings {
  std::uint64_t revision = 0;
  std::unordered_map<std::string, float> user_volumes;
  std::unordered_map<std::string, bool> user_mutes;
  std::unordered_map<std::string, float> stream_volumes;
  std::unordered_map<std::string, bool> stream_mutes;
};

std::string normalizeRemoteAudioIdentity(std::string_view identity);
float resolveRemoteAudioGain(
  const RemoteAudioSettings& settings,
  std::string_view participant_identity,
  bool stream_source
);

// Owns all receive-side AudioStreams and the single WASAPI mix renderer.
// Every operation is synchronous with respect to ownership: after removeTrack
// or stop returns, no worker can access the corresponding stream or this object.
class RemoteAudioOutput final {
 public:
  using FailureHandler = std::function<void(std::string, std::string)>;

  explicit RemoteAudioOutput(FailureHandler on_failure = {});
  ~RemoteAudioOutput();
  RemoteAudioOutput(const RemoteAudioOutput&) = delete;
  RemoteAudioOutput& operator=(const RemoteAudioOutput&) = delete;

  void addTrack(std::string track_sid, std::string participant_identity, bool stream,
                std::shared_ptr<livekit::Track> track);
  void removeTrack(const std::string& track_sid);
  void setDeafened(bool deafened);
  void setOutputDevice(std::string device_id);
  void setVolume(float volume);
  void configure(RemoteAudioSettings settings);
  void stop();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
