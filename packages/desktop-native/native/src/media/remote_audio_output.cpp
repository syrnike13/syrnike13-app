#include "remote_audio_output.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cmath>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <livekit/audio_stream.h>
#include <livekit/track.h>

#include "audio_devices.hpp"
#include "../common/diagnostic_log.hpp"
#include "voice_activity_detector.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::desktop_native::media {
namespace {
constexpr std::size_t kMaxQueuedSamplesPerTrack = 48'000; // one second at 48 kHz
constexpr std::size_t kStreamFrameCapacity = 20;
constexpr auto kHundredNanosecondsPerMillisecond = 10'000LL;
using diagnostics::DiagnosticField;

void logRemoteAudio(
  std::string_view event,
  std::initializer_list<DiagnosticField> fields = {}
) {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (logger.enabled()) logger.write(event, fields);
}

struct TrackState {
  std::shared_ptr<livekit::AudioStream> stream;
  std::jthread worker;
  std::deque<float> samples;
  std::string user_id;
  bool stream_source = false;
  float gain = 1.0F;
  VoiceActivityDetector activity;
};

}  // namespace

std::string normalizeRemoteAudioIdentity(std::string_view identity) {
  constexpr std::string_view prefix = "voice:v1|";
  if (!identity.starts_with(prefix)) return std::string(identity);
  auto remainder = identity.substr(prefix.size());
  std::array<std::string_view, 5> fields;
  for (std::size_t index = 0; index < fields.size() - 1; ++index) {
    const auto separator = remainder.find('|');
    if (separator == std::string_view::npos) return std::string(identity);
    fields[index] = remainder.substr(0, separator);
    remainder.remove_prefix(separator + 1);
  }
  fields.back() = remainder;
  if (
    (fields[0] != "web" && fields[0] != "windows_native") ||
    std::any_of(fields.begin(), fields.end(), [](auto field) {
      return field.empty() || field.find('|') != std::string_view::npos;
    })
  ) {
    return std::string(identity);
  }
  return std::string(fields.back());
}

float resolveRemoteAudioGain(
  const RemoteAudioSettings& settings,
  std::string_view participant_identity,
  bool stream_source
) {
  const auto user_id = normalizeRemoteAudioIdentity(participant_identity);
  const auto& volumes = stream_source ? settings.stream_volumes : settings.user_volumes;
  const auto& mutes = stream_source ? settings.stream_mutes : settings.user_mutes;
  const auto muted = mutes.find(user_id);
  if (muted != mutes.end() && muted->second) return 0.0F;
  const auto volume = volumes.find(user_id);
  return volume == volumes.end()
    ? 1.0F
    : std::clamp(volume->second, 0.0F, 3.0F);
}

class RemoteAudioOutput::Implementation {
 public:
  Implementation(
    FailureHandler on_failure,
    SpeakingActivityHandler on_speaking_activity
  ) : on_failure_(std::move(on_failure)),
      on_speaking_activity_(std::move(on_speaking_activity)) {}
  ~Implementation() { stop(); }

  void addTrack(std::string sid, std::string identity, bool stream,
                std::shared_ptr<livekit::Track> track) {
    if (!track || track->kind() != livekit::TrackKind::KIND_AUDIO) return;
    removeTrack(sid);
    livekit::AudioStream::Options options;
    options.capacity = kStreamFrameCapacity;
    auto state = std::make_unique<TrackState>();
    state->stream = livekit::AudioStream::fromTrack(track, options);
    state->user_id = normalizeRemoteAudioIdentity(identity);
    state->stream_source = stream;
    std::lock_guard lock(mutex_);
    if (stopping_) {
      state->stream->close();
      return;
    }
    applyGain(*state);
    const auto [inserted_track, inserted] = tracks_.emplace(
      std::move(sid), std::move(state)
    );
    if (!inserted) return;
    auto* state_ptr = inserted_track->second.get();
    logRemoteAudio(
      "remote_audio_track_added",
      {
        {"trackCount", static_cast<std::uint64_t>(tracks_.size())},
        {"streamSource", stream}
      }
    );
    state_ptr->worker = std::jthread([this, state_ptr](std::stop_token token) {
      livekit::AudioFrameEvent event;
      while (!token.stop_requested() && state_ptr->stream->read(event)) {
        const auto& frame = event.frame;
        const auto channels = std::max(1, frame.numChannels());
        const auto& input = frame.data();
        std::vector<std::string> speakers;
        bool speakers_changed = false;
        std::uint64_t activity_revision = 0;
        {
          std::lock_guard lock(mutex_);
          if (stopping_) break;
          double squared_sum = 0.0;
          std::size_t mono_samples = 0;
          for (std::size_t index = 0; index + channels <= input.size(); index += channels) {
            float mixed = 0.0F;
            for (int channel = 0; channel < channels; ++channel) {
              mixed += static_cast<float>(input[index + static_cast<std::size_t>(channel)]);
            }
            const auto sample = mixed / (32768.0F * static_cast<float>(channels));
            state_ptr->samples.push_back(sample);
            squared_sum += static_cast<double>(sample) * static_cast<double>(sample);
            ++mono_samples;
          }
          while (state_ptr->samples.size() > kMaxQueuedSamplesPerTrack) {
            state_ptr->samples.pop_front();
          }
          const auto output_gain = state_ptr->gain * volume_;
          if (
            !state_ptr->stream_source &&
            !deafened_ &&
            output_gain > 0.0F &&
            mono_samples != 0
          ) {
            const auto rms = static_cast<float>(std::sqrt(
              squared_sum / static_cast<double>(mono_samples)
            )) * output_gain;
            const auto changed = state_ptr->activity.updateRms(
              rms,
              true,
              std::chrono::steady_clock::now()
            );
            if (changed) {
              speakers = activeSpeakerIdentitiesLocked();
              speakers_changed = true;
              activity_revision = ++activity_revision_;
            }
          }
          ready_.notify_one();
        }
        if (speakers_changed) {
          notifySpeakingActivity(std::move(speakers), activity_revision);
        }
      }
      logRemoteAudio("remote_audio_stream_ended");
    });
  }

  void removeTrack(const std::string& sid) {
    std::unique_ptr<TrackState> removed;
    std::vector<std::string> speakers;
    bool speakers_changed = false;
    std::uint64_t activity_revision = 0;
    {
      std::lock_guard lock(mutex_);
      auto found = tracks_.find(sid);
      if (found == tracks_.end()) return;
      removed = std::move(found->second);
      tracks_.erase(found);
      if (removed->activity.reset()) {
        speakers = activeSpeakerIdentitiesLocked();
        speakers_changed = true;
        activity_revision = ++activity_revision_;
      }
    }
    removed->worker.request_stop();
    removed->stream->close();
    if (removed->worker.joinable()) removed->worker.join();
    if (speakers_changed) {
      notifySpeakingActivity(std::move(speakers), activity_revision);
    }
    logRemoteAudio("remote_audio_track_removed");
  }

  void setDeafened(bool value) {
    bool speakers_changed = false;
    std::uint64_t activity_revision = 0;
    {
      std::lock_guard lock(mutex_);
      deafened_ = value;
      if (value) for (auto& [_, track] : tracks_) {
        track->samples.clear();
        speakers_changed = track->activity.reset() || speakers_changed;
      }
      if (speakers_changed) activity_revision = ++activity_revision_;
    }
    if (speakers_changed) notifySpeakingActivity({}, activity_revision);
  }

  void setOutputDevice(std::string value) {
    {
      std::lock_guard lock(mutex_);
      if (stopping_ || (output_device_id_ == value && renderer_running_.load())) return;
    }
    stopRenderer();
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return;
      output_device_id_ = std::move(value);
    }
    startRenderer();
  }

  void setVolume(float value) {
    std::vector<std::string> speakers;
    bool speakers_changed = false;
    std::uint64_t activity_revision = 0;
    {
      std::lock_guard lock(mutex_);
      volume_ = std::clamp(value, 0.0F, 3.0F);
      if (volume_ <= 0.0F) {
        for (auto& [_, track] : tracks_) {
          speakers_changed = track->activity.reset() || speakers_changed;
        }
      }
      if (speakers_changed) {
        activity_revision = ++activity_revision_;
        speakers = activeSpeakerIdentitiesLocked();
      }
    }
    if (speakers_changed) {
      notifySpeakingActivity(std::move(speakers), activity_revision);
    }
  }

  void configure(RemoteAudioSettings settings) {
    std::vector<std::string> speakers;
    bool speakers_changed = false;
    std::uint64_t activity_revision = 0;
    {
      std::lock_guard lock(mutex_);
      if (settings.revision <= settings_.revision) return;
      settings_ = std::move(settings);
      for (auto& [_, track] : tracks_) {
        applyGain(*track);
        if (track->gain <= 0.0F) {
          speakers_changed = track->activity.reset() || speakers_changed;
        }
      }
      if (speakers_changed) {
        activity_revision = ++activity_revision_;
        speakers = activeSpeakerIdentitiesLocked();
      }
    }
    if (speakers_changed) {
      notifySpeakingActivity(std::move(speakers), activity_revision);
    }
  }

  void stop() {
    std::vector<std::unique_ptr<TrackState>> removed;
    bool speakers_changed = false;
    std::uint64_t activity_revision = 0;
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return;
      stopping_ = true;
      for (auto& [_, track] : tracks_) {
        speakers_changed = track->activity.reset() || speakers_changed;
        removed.push_back(std::move(track));
      }
      tracks_.clear();
      if (speakers_changed) activity_revision = ++activity_revision_;
    }
    for (auto& track : removed) {
      track->worker.request_stop();
      track->stream->close();
    }
    for (auto& track : removed) if (track->worker.joinable()) track->worker.join();
    if (speakers_changed) notifySpeakingActivity({}, activity_revision);
    stopRenderer();
  }

 private:
  std::vector<std::string> activeSpeakerIdentitiesLocked() const {
    std::vector<std::string> identities;
    identities.reserve(tracks_.size());
    for (const auto& [_, track] : tracks_) {
      if (
        track->activity.speaking() &&
        !track->stream_source &&
        !track->user_id.empty()
      ) {
        identities.push_back(track->user_id);
      }
    }
    std::sort(identities.begin(), identities.end());
    identities.erase(std::unique(identities.begin(), identities.end()), identities.end());
    return identities;
  }

  void notifySpeakingActivity(
    std::vector<std::string> identities,
    std::uint64_t revision
  ) {
    if (!on_speaking_activity_) return;
    std::lock_guard callback_lock(activity_callback_mutex_);
    {
      std::lock_guard state_lock(mutex_);
      if (revision != activity_revision_) return;
    }
    on_speaking_activity_(std::move(identities));
  }

  void startRenderer() {
    {
      std::lock_guard lock(mutex_);
      clearQueuedSamplesLocked();
    }
    renderer_running_.store(true);
    logRemoteAudio("remote_audio_renderer_start_requested");
    renderer_ = std::jthread([this](std::stop_token token) { render(token); });
  }

  void stopRenderer() {
    renderer_running_.store(false);
    ready_.notify_all();
    if (renderer_.joinable()) {
      renderer_.request_stop();
      renderer_.join();
    }
    std::lock_guard lock(mutex_);
    clearQueuedSamplesLocked();
  }

  void render(std::stop_token token) {
    const auto com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(com_result);
    DWORD task_index = 0;
    HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);
    std::string device_id;
    try {
      { std::lock_guard lock(mutex_); device_id = output_device_id_; }
      auto device = renderDevice(device_id);
      ComPtr<IAudioClient> client;
      if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
          reinterpret_cast<void**>(client.GetAddressOf())))) throw std::runtime_error("activate render device failed");
      auto format = desiredRenderFormat();
      constexpr auto requested_buffer_duration = remoteAudioRenderBufferDuration();
      if (FAILED(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
          AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
          requested_buffer_duration.count() * kHundredNanosecondsPerMillisecond,
          0, &format, nullptr))) throw std::runtime_error("initialize render stream failed");
      ComPtr<IAudioRenderClient> render_client;
      if (FAILED(client->GetService(IID_PPV_ARGS(&render_client)))) throw std::runtime_error("open render client failed");
      UINT32 capacity = 0;
      if (FAILED(client->GetBufferSize(&capacity)) || capacity == 0) throw std::runtime_error("query render capacity failed");
      if (FAILED(client->Start())) throw std::runtime_error("start render failed");
      logRemoteAudio(
        "remote_audio_renderer_started",
        {
          {"capacityFrames", static_cast<std::uint64_t>(capacity)},
          {"capacityMs", static_cast<std::uint64_t>(
            (static_cast<std::uint64_t>(capacity) * 1'000) / format.nSamplesPerSec
          )},
          {"requestedBufferMs", static_cast<std::uint64_t>(requested_buffer_duration.count())}
        }
      );
      while (!token.stop_requested() && renderer_running_.load()) {
        UINT32 padding = 0;
        if (FAILED(client->GetCurrentPadding(&padding))) {
          throw std::runtime_error("query render padding failed");
        }
        const UINT32 count = std::min<UINT32>(capacity - std::min(capacity, padding), 480);
        if (count != 0) {
          BYTE* output = nullptr;
          if (FAILED(render_client->GetBuffer(count, &output))) {
            throw std::runtime_error("acquire render buffer failed");
          }
          auto* samples = reinterpret_cast<float*>(output);
          bool deafened = false;
          {
            std::lock_guard lock(mutex_);
            deafened = deafened_;
            for (UINT32 index = 0; index < count; ++index) {
              float sample = 0.0F;
              if (!deafened) {
                for (auto& [_, track] : tracks_) if (!track->samples.empty()) {
                  sample += track->samples.front() * track->gain;
                  track->samples.pop_front();
                }
              }
              samples[index] = std::clamp(sample * volume_, -1.0F, 1.0F);
            }
          }
          if (FAILED(render_client->ReleaseBuffer(
                count,
                deafened ? AUDCLNT_BUFFERFLAGS_SILENT : 0
              ))) {
            throw std::runtime_error("release render buffer failed");
          }
        }
        std::vector<std::string> speaking_identities;
        bool speaking_changed = false;
        std::uint64_t speaking_revision = 0;
        {
          std::lock_guard lock(mutex_);
          const auto now = std::chrono::steady_clock::now();
          for (auto& [_, track] : tracks_) {
            if (track->stream_source) continue;
            const auto enabled = !deafened_ && track->gain * volume_ > 0.0F;
            const auto changed = enabled
              ? track->activity.updateRms(0.0F, true, now)
              : track->activity.reset();
            if (!changed) continue;
            speaking_identities = activeSpeakerIdentitiesLocked();
            speaking_changed = true;
            speaking_revision = ++activity_revision_;
          }
        }
        if (speaking_changed) {
          notifySpeakingActivity(std::move(speaking_identities), speaking_revision);
        }
        std::unique_lock lock(mutex_);
        ready_.wait_for(lock, std::chrono::milliseconds(2));
      }
      client->Stop();
      logRemoteAudio("remote_audio_renderer_stopped");
    } catch (const std::exception& error) {
      logRemoteAudio("remote_audio_renderer_failed", {{"message", error.what()}});
      if (!token.stop_requested() && renderer_running_.load() && on_failure_) {
        on_failure_(error.what(), device_id);
      }
    } catch (...) {
      logRemoteAudio("remote_audio_renderer_failed", {{"message", "unknown"}});
      if (!token.stop_requested() && renderer_running_.load() && on_failure_) {
        on_failure_("Remote audio renderer failed", device_id);
      }
    }
    if (avrt) AvRevertMmThreadCharacteristics(avrt);
    if (com_initialized) CoUninitialize();
    renderer_running_.store(false);
  }


  void applyGain(TrackState& track) {
    track.gain = resolveRemoteAudioGain(
      settings_,
      track.user_id,
      track.stream_source
    );
  }

  void clearQueuedSamplesLocked() {
    for (auto& [_, track] : tracks_) track->samples.clear();
  }

  std::mutex mutex_;
  std::mutex activity_callback_mutex_;
  std::condition_variable ready_;
  std::unordered_map<std::string, std::unique_ptr<TrackState>> tracks_;
  std::string output_device_id_ = "default";
  bool deafened_ = false;
  float volume_ = 1.0F;
  bool stopping_ = false;
  std::atomic_bool renderer_running_{false};
  std::jthread renderer_;
  RemoteAudioSettings settings_;
  FailureHandler on_failure_;
  SpeakingActivityHandler on_speaking_activity_;
  std::uint64_t activity_revision_ = 0;
};

RemoteAudioOutput::RemoteAudioOutput(
  FailureHandler on_failure,
  SpeakingActivityHandler on_speaking_activity
) : implementation_(std::make_unique<Implementation>(
      std::move(on_failure),
      std::move(on_speaking_activity)
    )) {}
RemoteAudioOutput::~RemoteAudioOutput() = default;
void RemoteAudioOutput::addTrack(std::string sid, std::string identity, bool stream, std::shared_ptr<livekit::Track> track) { implementation_->addTrack(std::move(sid), std::move(identity), stream, std::move(track)); }
void RemoteAudioOutput::removeTrack(const std::string& sid) { implementation_->removeTrack(sid); }
void RemoteAudioOutput::setDeafened(bool value) { implementation_->setDeafened(value); }
void RemoteAudioOutput::setOutputDevice(std::string id) { implementation_->setOutputDevice(std::move(id)); }
void RemoteAudioOutput::setVolume(float volume) { implementation_->setVolume(volume); }
void RemoteAudioOutput::configure(RemoteAudioSettings settings) { implementation_->configure(std::move(settings)); }
void RemoteAudioOutput::stop() { implementation_->stop(); }

}  // namespace syrnike::desktop_native::media
