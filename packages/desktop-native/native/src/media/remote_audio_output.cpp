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
#include <exception>
#include <mutex>
#include <optional>
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

bool retainAudioOutputEndpointRetry(
  AudioOutputDeviceIntent intent,
  AudioFailureKind failure
) noexcept {
  return intent == AudioOutputDeviceIntent::EndpointRecovery &&
    audioFailureAllowsDefaultFallback(failure);
}

void startAudioOutputWithRollback(
  const std::function<void()>& start_candidate,
  const std::function<void()>& restore_previous,
  const std::function<void()>& start_previous
) {
  try {
    start_candidate();
    return;
  } catch (...) {
    const auto candidate_failure = std::current_exception();
    restore_previous();
    try {
      start_previous();
    } catch (const std::exception& rollback_error) {
      const auto failure = describeAudioFailure(rollback_error);
      throw AudioFailure(
        AudioFailureKind::RollbackFailed,
        "previous audio output rollback failed: " + failure.message,
        failure.hresult
      );
    } catch (...) {
      throw AudioFailure(
        AudioFailureKind::RollbackFailed,
        "previous audio output rollback failed",
        S_OK
      );
    }
    std::rethrow_exception(candidate_failure);
  }
}

namespace {
constexpr std::size_t kRemoteAudioSampleRate = 48'000;
constexpr std::size_t kRemoteAudioChannels = remoteAudioRenderChannels();
constexpr std::size_t kPlayoutStartFrames =
  kRemoteAudioSampleRate * remoteAudioPlayoutStartDuration().count() / 1'000;
constexpr std::size_t kPlayoutTargetFrames = 2'400; // 50 ms at 48 kHz
constexpr std::size_t kMaxQueuedFramesPerTrack =
  kRemoteAudioSampleRate * remoteAudioMaxQueuedDuration().count() / 1'000;
constexpr std::size_t kStreamFrameCapacity = 20;
constexpr auto kHundredNanosecondsPerMillisecond = 10'000LL;
constexpr float kLimiterCeiling = 0.98F;
constexpr float kLimiterReleaseSeconds = 0.5F;
using diagnostics::DiagnosticField;

struct StereoFrame {
  float left = 0.0F;
  float right = 0.0F;
};

WAVEFORMATEX desiredRemoteAudioRenderFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = static_cast<WORD>(kRemoteAudioChannels);
  format.nSamplesPerSec = static_cast<DWORD>(kRemoteAudioSampleRate);
  format.wBitsPerSample = 32;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  return format;
}

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
  std::deque<StereoFrame> frames;
  std::string user_id;
  bool stream_source = false;
  bool playout_started = false;
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

float remoteAudioLimiterTargetGain(float peak) noexcept {
  if (!std::isfinite(peak) || peak <= kLimiterCeiling) return 1.0F;
  return kLimiterCeiling / peak;
}

class RemoteAudioOutput::Implementation {
 public:
  Implementation(
    FailureHandler on_failure,
    SpeakingActivityHandler on_speaking_activity,
    WorkerFactory worker_factory
  ) : on_failure_(std::move(on_failure)),
      on_speaking_activity_(std::move(on_speaking_activity)),
      worker_factory_(std::move(worker_factory)) {
    if (!worker_factory_) {
      worker_factory_ = [](WorkerTask task) {
        return std::jthread(std::move(task));
      };
    }
    try {
      endpoint_monitor_ = std::make_unique<AudioEndpointMonitor>(
        eRender,
        [this](AudioEndpointChange change) { handleEndpointChange(std::move(change)); }
      );
  } catch (const std::exception& error) {
      logRemoteAudio("remote_audio_endpoint_monitor_unavailable", {{"message", error.what()}});
    }
  }
  ~Implementation() { stop(); }

  void addTrack(std::string sid, std::string identity, bool stream,
                std::shared_ptr<livekit::Track> track) {
    if (!track || track->kind() != livekit::TrackKind::KIND_AUDIO) return;
    removeTrack(sid);
    auto state = std::make_unique<TrackState>();
    try {
      livekit::AudioStream::Options options;
      options.capacity = kStreamFrameCapacity;
      state->stream = livekit::AudioStream::fromTrack(track, options);
      state->user_id = normalizeRemoteAudioIdentity(identity);
      state->stream_source = stream;
    } catch (const std::exception& error) {
      notifyTrackStartFailure(error, sid);
      return;
    } catch (...) {
      notifyTrackStartFailure("unknown remote audio stream creation failure", sid);
      return;
    }
    auto* state_ptr = state.get();
    WorkerTask worker_task = [this, state_ptr](std::stop_token token) {
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
            float mono = 0.0F;
            for (int channel = 0; channel < channels; ++channel) {
              mono += static_cast<float>(input[index + static_cast<std::size_t>(channel)]);
            }
            mono /= 32768.0F * static_cast<float>(channels);
            const auto left = static_cast<float>(input[index]) / 32768.0F;
            const auto right = channels == 1
              ? left
              : static_cast<float>(input[index + 1]) / 32768.0F;
            state_ptr->frames.push_back({left, right});
            squared_sum += static_cast<double>(mono) * static_cast<double>(mono);
            ++mono_samples;
          }
          if (state_ptr->frames.size() > kMaxQueuedFramesPerTrack) {
            const auto dropped = state_ptr->frames.size() - kPlayoutTargetFrames;
            for (std::size_t index = 0; index < dropped; ++index) {
              state_ptr->frames.pop_front();
            }
            state_ptr->playout_started = false;
            logRemoteAudio(
              "remote_audio_buffer_overrun",
              {{"droppedFrames", static_cast<std::uint64_t>(dropped)}}
            );
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
    };
    bool discard = false;
    std::size_t track_count = 0;
    std::unique_ptr<TrackState> rolled_back;
    std::exception_ptr startup_failure;
    try {
      std::lock_guard lock(mutex_);
      if (stopping_ || tracks_.contains(sid)) {
        discard = true;
      } else {
        applyGain(*state);
        const auto [_, inserted] = tracks_.try_emplace(sid, std::move(state));
        if (!inserted) {
          discard = true;
        } else {
          try {
            state_ptr->worker = worker_factory_(std::move(worker_task));
            track_count = tracks_.size();
          } catch (...) {
            startup_failure = std::current_exception();
            rolled_back = std::move(tracks_.at(sid));
            tracks_.erase(sid);
          }
        }
      }
    } catch (...) {
      startup_failure = std::current_exception();
      if (state) rolled_back = std::move(state);
    }
    if (discard) {
      state->worker.request_stop();
      state->stream->close();
      if (state->worker.joinable()) state->worker.join();
      return;
    }
    if (startup_failure) {
      if (rolled_back && rolled_back->stream) rolled_back->stream->close();
      try {
        std::rethrow_exception(startup_failure);
      } catch (const std::exception& error) {
        notifyTrackStartFailure(error, sid);
      } catch (...) {
        notifyTrackStartFailure("unknown audio worker construction failure", sid);
      }
      return;
    }
    logRemoteAudio(
      "remote_audio_track_added",
      {
        {"trackCount", static_cast<std::uint64_t>(track_count)},
        {"streamSource", stream}
      }
    );
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
        track->frames.clear();
        track->playout_started = false;
        speakers_changed = track->activity.reset() || speakers_changed;
      }
      if (speakers_changed) activity_revision = ++activity_revision_;
    }
    if (speakers_changed) notifySpeakingActivity({}, activity_revision);
  }

  std::uint64_t setOutputDevice(
    std::string value,
    AudioOutputDeviceIntent intent
  ) {
    std::lock_guard switch_lock(device_switch_mutex_);
    bool previous_configured = false;
    bool previous_fallback_pending = false;
    {
      std::lock_guard lock(mutex_);
      previous_configured = output_configured_;
      previous_fallback_pending = output_fallback_pending_;
      output_configured_ = true;
      output_fallback_pending_ = false;
    }
    try {
      return applyOutputDeviceLocked(std::move(value), false);
    } catch (const AudioFailure& failure) {
      std::lock_guard lock(mutex_);
      if (!stopping_) {
        const bool rollback_failed =
          failure.kind() == AudioFailureKind::RollbackFailed;
        const bool retain_recovery = retainAudioOutputEndpointRetry(
          intent,
          failure.kind()
        );
        if (rollback_failed ||
            intent == AudioOutputDeviceIntent::EndpointRecovery) {
          output_fallback_pending_ = retain_recovery;
          output_configured_ = retain_recovery;
        } else {
          output_fallback_pending_ = previous_fallback_pending;
          output_configured_ = previous_configured;
        }
      }
      throw;
    } catch (...) {
      std::lock_guard lock(mutex_);
      if (!stopping_) {
        if (intent == AudioOutputDeviceIntent::EndpointRecovery) {
          output_fallback_pending_ = false;
          output_configured_ = false;
        } else {
          output_fallback_pending_ = previous_fallback_pending;
          output_configured_ = previous_configured;
        }
      }
      throw;
    }
  }

  bool isRendererEpochCurrent(std::uint64_t epoch) const {
    std::lock_guard lock(mutex_);
    return epoch != 0 && renderer_epoch_ == epoch;
  }

  std::uint64_t applyOutputDeviceLocked(std::string value, bool force) {
    {
      std::lock_guard lock(mutex_);
      if (stopping_ || (!force && output_device_id_ == value && renderer_running_.load())) {
        return renderer_epoch_;
      }
    }
    const auto requested = value;
    try {
      probeRenderDevice(value, desiredRemoteAudioRenderFormat(), std::chrono::milliseconds(750));
    } catch (const AudioFailure& failure) {
      if (value.empty() || value == "default") {
        throw;
      }
      if (!audioFailureAllowsDefaultFallback(failure.kind())) {
        throw;
      }
      value = "default";
      probeRenderDevice(value, desiredRemoteAudioRenderFormat(), std::chrono::milliseconds(750));
    }
    std::string previous;
    {
      std::lock_guard lock(mutex_);
      previous = output_device_id_;
    }
    stopRenderer();
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return renderer_epoch_;
      output_device_id_ = std::move(value);
    }
    startAudioOutputWithRollback(
      [this] { startRenderer(); },
      [this, &previous] {
        std::lock_guard lock(mutex_);
        output_device_id_ = previous;
      },
      [this] { startRenderer(); }
    );
    std::string active;
    {
      std::lock_guard lock(mutex_);
      active = output_device_id_;
    }
    std::uint64_t active_epoch = 0;
    {
      std::lock_guard lock(mutex_);
      active_epoch = renderer_epoch_;
    }
    if (requested != active && on_failure_) {
      on_failure_(AudioFailureInfo{
        AudioFailureKind::EndpointInvalidated,
        "audio_output_fallback_default",
        "Selected audio output is unavailable; using system default",
        AUDCLNT_E_DEVICE_INVALIDATED,
        false,
      }, requested, active_epoch);
    }
    return active_epoch;
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
    // Endpoint notifications run on their own COM worker. Serialize the full
    // renderer teardown with device switching so only one thread can move,
    // stop, or join renderer_ at a time.
    std::lock_guard switch_lock(device_switch_mutex_);
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
  void notifyTrackStartFailure(
    const std::exception& error,
    std::string_view track_id
  ) noexcept {
    notifyTrackStartFailure(error.what(), track_id);
  }

  void notifyTrackStartFailure(
    std::string_view message,
    std::string_view track_id
  ) noexcept {
    try {
      if (!on_failure_) return;
      std::uint64_t epoch = 0;
      {
        std::lock_guard lock(mutex_);
        epoch = renderer_epoch_;
      }
      AudioFailureInfo failure{
        AudioFailureKind::IoFailed,
        "audio_output_stream_start_failed",
        "Remote audio stream worker failed to start: " + std::string(message),
        S_OK,
        true,
      };
      on_failure_(std::move(failure), std::string(track_id), epoch);
    } catch (...) {
      logRemoteAudio("remote_audio_track_failure_callback_failed");
    }
  }

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
      std::lock_guard lock(renderer_startup_mutex_);
      renderer_ready_ = false;
      renderer_startup_failure_.reset();
    }
    limiter_gain_ = 1.0F;
    renderer_running_.store(true);
    std::uint64_t renderer_epoch = 0;
    {
      std::lock_guard lock(mutex_);
      renderer_epoch = ++renderer_epoch_;
    }
    logRemoteAudio("remote_audio_renderer_start_requested");
    try {
      renderer_ = std::jthread([this, renderer_epoch](std::stop_token token) {
        render(token, renderer_epoch);
      });
    } catch (...) {
      renderer_running_.store(false);
      throw;
    }
    std::unique_lock lock(renderer_startup_mutex_);
    if (!renderer_startup_changed_.wait_for(lock, std::chrono::seconds(2), [&] {
          return renderer_ready_ || renderer_startup_failure_.has_value();
        })) {
      lock.unlock();
      stopRenderer();
      throw AudioFailure(
        AudioFailureKind::OperationTimedOut,
        "audio output produced no render progress before deadline",
        HRESULT_FROM_WIN32(WAIT_TIMEOUT)
      );
    }
    if (renderer_startup_failure_) {
      const auto failure = *renderer_startup_failure_;
      lock.unlock();
      stopRenderer();
      throw AudioFailure(failure.kind, failure.message, failure.hresult);
    }
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

  void render(std::stop_token token, std::uint64_t renderer_epoch) {
    const auto com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(com_result);
    DWORD task_index = 0;
    HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);
    std::string device_id;
    try {
      { std::lock_guard lock(mutex_); device_id = output_device_id_; }
      auto device = renderDevice(device_id);
      const auto activate_audio_client = [&] {
        ComPtr<IAudioClient> candidate;
        const auto result = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
            reinterpret_cast<void**>(candidate.GetAddressOf()));
        if (FAILED(result)) {
          throwAudioFailure(result, "activate render device failed");
        }
        return candidate;
      };
      auto client = activate_audio_client();
      std::string category_status = "unsupported";
      ComPtr<IAudioClient2> client2;
      if (SUCCEEDED(client.As(&client2))) {
        AudioClientProperties properties{};
        properties.cbSize = sizeof(properties);
        properties.bIsOffload = FALSE;
        properties.eCategory = AudioCategory_GameChat;
        properties.Options = AUDCLNT_STREAMOPTIONS_NONE;
        if (SUCCEEDED(client2->SetClientProperties(&properties))) {
          category_status = "game_chat";
        }
      }
      auto format = desiredRemoteAudioRenderFormat();
      constexpr auto requested_buffer_duration = remoteAudioRenderBufferDuration();
      const auto initialize_audio_client = [&](const ComPtr<IAudioClient>& candidate) {
        return candidate->Initialize(AUDCLNT_SHAREMODE_SHARED,
          AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
          requested_buffer_duration.count() * kHundredNanosecondsPerMillisecond,
          0, &format, nullptr);
      };
      auto initialize_result = initialize_audio_client(client);
      if (FAILED(initialize_result) && category_status == "game_chat") {
        client = activate_audio_client();
        category_status = "fallback";
        initialize_result = initialize_audio_client(client);
      }
      if (FAILED(initialize_result)) {
        throwAudioFailure(initialize_result, "initialize render stream failed");
      }
      ComPtr<IAudioRenderClient> render_client;
      const auto service_result = client->GetService(IID_PPV_ARGS(&render_client));
      if (FAILED(service_result)) {
        throwAudioFailure(service_result, "open render client failed");
      }
      UINT32 capacity = 0;
      const auto capacity_result = client->GetBufferSize(&capacity);
      if (FAILED(capacity_result) || capacity == 0) {
        throwAudioFailure(
          FAILED(capacity_result) ? capacity_result : S_OK,
          "query render capacity failed",
          AudioFailureKind::IoFailed
        );
      }
      BYTE* initial_output = nullptr;
      const auto prime_result = render_client->GetBuffer(capacity, &initial_output);
      if (FAILED(prime_result)) {
        throwAudioFailure(prime_result, "prime render buffer failed", AudioFailureKind::IoFailed);
      }
      (void)initial_output;
      const auto release_prime_result = render_client->ReleaseBuffer(
        capacity, AUDCLNT_BUFFERFLAGS_SILENT);
      if (FAILED(release_prime_result)) {
        throwAudioFailure(
          release_prime_result,
          "release primed render buffer failed",
          AudioFailureKind::IoFailed
        );
      }
      const auto start_result = client->Start();
      if (FAILED(start_result)) {
        throwAudioFailure(start_result, "start render failed", AudioFailureKind::ClientStartFailed);
      }
      while (!token.stop_requested() && renderer_running_.load()) {
        UINT32 padding = 0;
        const auto padding_result = client->GetCurrentPadding(&padding);
        if (FAILED(padding_result)) {
          throwAudioFailure(padding_result, "query render padding failed", AudioFailureKind::IoFailed);
        }
        const UINT32 count = std::min<UINT32>(capacity - std::min(capacity, padding), 480);
        if (count != 0) {
          BYTE* output = nullptr;
          const auto buffer_result = render_client->GetBuffer(count, &output);
          if (FAILED(buffer_result)) {
            throwAudioFailure(buffer_result, "acquire render buffer failed", AudioFailureKind::IoFailed);
          }
          auto* samples = reinterpret_cast<float*>(output);
          bool deafened = false;
          float output_volume = 1.0F;
          std::size_t underflowed_tracks = 0;
          std::vector<StereoFrame> mixed(count);
          {
            std::lock_guard lock(mutex_);
            deafened = deafened_;
            output_volume = volume_;
            for (UINT32 index = 0; index < count; ++index) {
              for (auto& [_, track] : tracks_) {
                if (!track->playout_started) {
                  if (track->frames.size() < kPlayoutStartFrames) continue;
                  track->playout_started = true;
                }
                if (track->frames.empty()) {
                  track->playout_started = false;
                  ++underflowed_tracks;
                  continue;
                }
                const auto frame = track->frames.front();
                track->frames.pop_front();
                if (deafened) continue;
                mixed[index].left += frame.left * track->gain;
                mixed[index].right += frame.right * track->gain;
              }
            }
          }
          if (underflowed_tracks != 0) {
            logRemoteAudio(
              "remote_audio_buffer_underrun",
              {{"trackCount", static_cast<std::uint64_t>(underflowed_tracks)}}
            );
          }

          float peak = 0.0F;
          for (auto& frame : mixed) {
            frame.left *= output_volume;
            frame.right *= output_volume;
            peak = std::max(peak, std::abs(frame.left));
            peak = std::max(peak, std::abs(frame.right));
          }
          const auto target_limiter_gain = remoteAudioLimiterTargetGain(peak);
          if (target_limiter_gain < limiter_gain_) {
            limiter_gain_ = target_limiter_gain;
          } else {
            const auto release = static_cast<float>(count) /
              (static_cast<float>(kRemoteAudioSampleRate) * kLimiterReleaseSeconds);
            limiter_gain_ = std::min(target_limiter_gain, limiter_gain_ + release);
          }
          for (UINT32 index = 0; index < count; ++index) {
            samples[index * kRemoteAudioChannels] =
              std::clamp(mixed[index].left * limiter_gain_, -1.0F, 1.0F);
            samples[index * kRemoteAudioChannels + 1] =
              std::clamp(mixed[index].right * limiter_gain_, -1.0F, 1.0F);
          }
          const auto release_result = render_client->ReleaseBuffer(
                count,
                deafened ? AUDCLNT_BUFFERFLAGS_SILENT : 0
              );
          if (FAILED(release_result)) {
            throwAudioFailure(release_result, "release render buffer failed", AudioFailureKind::IoFailed);
          }
          bool became_ready = false;
          {
            std::lock_guard lock(renderer_startup_mutex_);
            if (!renderer_ready_) {
              renderer_ready_ = true;
              became_ready = true;
            }
          }
          if (became_ready) {
            renderer_startup_changed_.notify_all();
            logRemoteAudio(
              "remote_audio_renderer_started",
              {
                {"capacityFrames", static_cast<std::uint64_t>(capacity)},
                {"capacityMs", static_cast<std::uint64_t>(
                  (static_cast<std::uint64_t>(capacity) * 1'000) / format.nSamplesPerSec
                )},
                {"requestedBufferMs", static_cast<std::uint64_t>(requested_buffer_duration.count())},
                {"category", category_status}
              }
            );
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
      const auto failure = describeAudioFailure(error);
      bool failed_after_readiness = false;
      {
        std::lock_guard lock(renderer_startup_mutex_);
        failed_after_readiness = renderer_ready_;
        if (!failed_after_readiness) renderer_startup_failure_ = failure;
      }
      renderer_startup_changed_.notify_all();
      if (failed_after_readiness && !token.stop_requested() &&
          renderer_running_.load() && on_failure_) {
        on_failure_(failure, device_id, renderer_epoch);
      }
    } catch (...) {
      logRemoteAudio("remote_audio_renderer_failed", {{"message", "unknown"}});
      const AudioFailureInfo failure{
        AudioFailureKind::Unknown,
        "audio_unknown",
        "Remote audio renderer failed",
        S_OK,
        true,
      };
      bool failed_after_readiness = false;
      {
        std::lock_guard lock(renderer_startup_mutex_);
        failed_after_readiness = renderer_ready_;
        if (!failed_after_readiness) renderer_startup_failure_ = failure;
      }
      renderer_startup_changed_.notify_all();
      if (failed_after_readiness && !token.stop_requested() &&
          renderer_running_.load() && on_failure_) {
        on_failure_(failure, device_id, renderer_epoch);
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
    for (auto& [_, track] : tracks_) {
      track->frames.clear();
      track->playout_started = false;
    }
  }

  void handleEndpointChange(AudioEndpointChange change) {
    // Serialize the decision with the switch itself. A notification queued for
    // device A must re-read the current intent after an explicit switch to B;
    // otherwise the stale notification can roll B back to the default device.
    std::lock_guard switch_lock(device_switch_mutex_);
    std::string selected;
    bool fallback_pending = false;
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return;
      selected = output_device_id_;
      fallback_pending = output_fallback_pending_;
      if (!configuredAudioOutputEndpointChangeRequiresDefaultRetry(
            output_configured_, selected, fallback_pending, change)) return;
    }
    const bool follows_default = selected.empty() || selected == "default";
    const bool selected_lost = !follows_default && selected == change.device_id;
    try {
      applyOutputDeviceLocked("default", true);
      {
        std::lock_guard lock(mutex_);
        output_fallback_pending_ = false;
      }
      if ((selected_lost || fallback_pending) && on_failure_) {
        std::uint64_t active_epoch = 0;
        {
          std::lock_guard lock(mutex_);
          active_epoch = renderer_epoch_;
        }
        const bool explicit_fallback = !follows_default;
        on_failure_(AudioFailureInfo{
          AudioFailureKind::EndpointInvalidated,
          explicit_fallback
            ? "audio_output_fallback_default"
            : "audio_output_default_recovered",
          explicit_fallback
            ? "Selected audio output disappeared; using system default"
            : "Default audio output recovered",
          AUDCLNT_E_DEVICE_INVALIDATED,
          false,
        }, selected, active_epoch);
      }
    } catch (const std::exception& error) {
      const auto failure = describeAudioFailure(error);
      {
        std::lock_guard lock(mutex_);
        if (!stopping_) {
          output_fallback_pending_ =
            audioFailureAllowsDefaultFallback(failure.kind);
        }
      }
      if (on_failure_) {
        std::uint64_t active_epoch = 0;
        {
          std::lock_guard lock(mutex_);
          active_epoch = renderer_epoch_;
        }
        on_failure_(failure, "default", active_epoch);
      }
    }
  }

  mutable std::mutex mutex_;
  std::mutex device_switch_mutex_;
  std::mutex renderer_startup_mutex_;
  std::condition_variable renderer_startup_changed_;
  std::mutex activity_callback_mutex_;
  std::condition_variable ready_;
  std::unordered_map<std::string, std::unique_ptr<TrackState>> tracks_;
  std::string output_device_id_ = "default";
  bool output_fallback_pending_ = false;
  bool output_configured_ = false;
  bool deafened_ = false;
  float volume_ = 1.0F;
  bool stopping_ = false;
  std::atomic_bool renderer_running_{false};
  std::jthread renderer_;
  std::uint64_t renderer_epoch_ = 0;
  bool renderer_ready_ = false;
  std::optional<AudioFailureInfo> renderer_startup_failure_;
  float limiter_gain_ = 1.0F;
  RemoteAudioSettings settings_;
  FailureHandler on_failure_;
  SpeakingActivityHandler on_speaking_activity_;
  WorkerFactory worker_factory_;
  std::uint64_t activity_revision_ = 0;
  std::unique_ptr<AudioEndpointMonitor> endpoint_monitor_;
};

RemoteAudioOutput::RemoteAudioOutput(
  FailureHandler on_failure,
  SpeakingActivityHandler on_speaking_activity,
  WorkerFactory worker_factory
) : implementation_(std::make_unique<Implementation>(
      std::move(on_failure),
      std::move(on_speaking_activity),
      std::move(worker_factory)
    )) {}
RemoteAudioOutput::~RemoteAudioOutput() = default;
void RemoteAudioOutput::addTrack(std::string sid, std::string identity, bool stream, std::shared_ptr<livekit::Track> track) { implementation_->addTrack(std::move(sid), std::move(identity), stream, std::move(track)); }
void RemoteAudioOutput::removeTrack(const std::string& sid) { implementation_->removeTrack(sid); }
void RemoteAudioOutput::setDeafened(bool value) { implementation_->setDeafened(value); }
std::uint64_t RemoteAudioOutput::setOutputDevice(
  std::string id,
  AudioOutputDeviceIntent intent
) {
  return implementation_->setOutputDevice(std::move(id), intent);
}
bool RemoteAudioOutput::isRendererEpochCurrent(std::uint64_t epoch) const { return implementation_->isRendererEpochCurrent(epoch); }
void RemoteAudioOutput::setVolume(float volume) { implementation_->setVolume(volume); }
void RemoteAudioOutput::configure(RemoteAudioSettings settings) { implementation_->configure(std::move(settings)); }
void RemoteAudioOutput::stop() { implementation_->stop(); }

}  // namespace syrnike::desktop_native::media
