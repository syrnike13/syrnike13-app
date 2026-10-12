#include "audio/remote_audio_playout.hpp"

#include <windows.h>
#include <audioclient.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <livekit/fresh_audio_stream.h>
#include <livekit/livekit.h>

#include <algorithm>
#include <charconv>
#include <memory>
#include <stdexcept>

namespace syrnike::windows_media::audio {
namespace {
using Clock = std::chrono::steady_clock;
using Microsoft::WRL::ComPtr;
using namespace std::chrono_literals;
// LiveKit disables its built-in playback through the default process session.
// Keep product output in a dedicated, stable session so device replacement
// preserves Windows mixer preferences without inheriting the SDK's mute.
constexpr GUID kOutputAudioSession{
    0x3a1665b2, 0xa3b5, 0x467c, {0x9b, 0x1c, 0x39, 0xf0, 0x46, 0x2f, 0xe3, 0x57}};
// 20 ms device buffer, written in whole 10 ms frames.
constexpr REFERENCE_TIME kDeviceBuffer100ns = 200'000;
constexpr auto kDeviceRetry = 2s;
// Renderer epochs fence echo references in the warm microphone DSP, which
// outlives every device. They never repeat within a process.
std::atomic<std::uint64_t> next_renderer_epoch{0};

bool validIdentity(std::string_view value) {
  return !value.empty() && value.size() <= 256 &&
      std::all_of(value.begin(), value.end(), [](unsigned char ch) { return ch >= 0x21 && ch <= 0x7e; });
}
bool supported(const livekit::RemoteTrackPublication& publication) {
  const auto source = publication.source();
  return (publication.kind() == livekit::TrackKind::KIND_AUDIO &&
          (source == livekit::TrackSource::SOURCE_MICROPHONE ||
           source == livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO)) ||
      (publication.kind() == livekit::TrackKind::KIND_VIDEO &&
       source == livekit::TrackSource::SOURCE_SCREENSHARE);
}
std::int64_t timestamp100ns() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
AudioDeviceIntent outputDevice(const OutputIntent& intent) {
  AudioDeviceIntent result{AudioDirection::output, {}};
  if (!intent.device_id) return result;
  AudioDeviceId id = 0;
  const auto& text = *intent.device_id;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), id);
  if (parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size() && id != 0) result.explicit_id = id;
  return result;
}
struct Apartment {
  HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
};
struct Mmcss {
  DWORD task = 0;
  HANDLE value = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
  ~Mmcss() { if (value) AvRevertMmThreadCharacteristics(value); }
};
struct ExternalPlayout {
  ExternalPlayout() { livekit::setExternalAudioPlayout(true); }
  ~ExternalPlayout() { livekit::setExternalAudioPlayout(false); }
};
}  // namespace

// One open shared-mode render client, owned by the playout thread.
struct RemoteAudioPlayout::Device {
  std::wstring endpoint_id;
  ComPtr<IAudioClient2> client;
  ComPtr<IAudioRenderClient> render;
  HANDLE event = nullptr;
  UINT32 buffer_frames = 0;
  std::uint32_t latency_ms = 0;
  std::shared_ptr<RenderedEchoReference> echo;
  EchoReferenceFrame reference;
  bool started = false;
  ~Device() {
    if (client && started) { (void)client->Stop(); (void)client->Reset(); }
    if (echo) echo->retire();
    if (event) CloseHandle(event);
  }
  static HRESULT open(const AudioEndpoint& endpoint, std::unique_ptr<Device>& result) {
    auto device = std::make_unique<Device>();
    device->endpoint_id = endpoint.endpoint_id;
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT status = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    ComPtr<IMMDevice> endpoint_device;
    if (SUCCEEDED(status)) status = enumerator->GetDevice(endpoint.endpoint_id.c_str(), &endpoint_device);
    if (SUCCEEDED(status)) status = endpoint_device->Activate(__uuidof(IAudioClient2), CLSCTX_ALL, nullptr,
        reinterpret_cast<void**>(device->client.GetAddressOf()));
    if (SUCCEEDED(status)) {
      AudioClientProperties properties{};
      properties.cbSize = sizeof(properties);
      properties.eCategory = AudioCategory_Other;
      status = device->client->SetClientProperties(&properties);
    }
    WAVEFORMATEX format{WAVE_FORMAT_PCM, 2, kRemoteAudioRate, kRemoteAudioRate * 4, 4, 16, 0};
    if (SUCCEEDED(status)) status = device->client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        kDeviceBuffer100ns, 0, &format, &kOutputAudioSession);
    if (SUCCEEDED(status)) {
      device->event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
      status = device->event ? device->client->SetEventHandle(device->event) : HRESULT_FROM_WIN32(GetLastError());
    }
    if (SUCCEEDED(status)) status = device->client->GetService(IID_PPV_ARGS(&device->render));
    if (SUCCEEDED(status)) status = device->client->GetBufferSize(&device->buffer_frames);
    REFERENCE_TIME latency = 0;
    if (SUCCEEDED(status)) status = device->client->GetStreamLatency(&latency);
    if (SUCCEEDED(status) && device->buffer_frames < kRemoteAudioFrames) status = AUDCLNT_E_BUFFER_SIZE_ERROR;
    if (SUCCEEDED(status)) {
      // Prime the whole buffer with silence so the first period cannot starve.
      BYTE* data = nullptr;
      status = device->render->GetBuffer(device->buffer_frames, &data);
      if (SUCCEEDED(status)) status = device->render->ReleaseBuffer(device->buffer_frames, AUDCLNT_BUFFERFLAGS_SILENT);
    }
    if (SUCCEEDED(status)) status = device->client->Start();
    if (FAILED(status)) return status;
    device->started = true;
    device->latency_ms = static_cast<std::uint32_t>(latency / 10'000);
    const auto epoch = ++next_renderer_epoch;
    device->echo = std::make_shared<RenderedEchoReference>(epoch);
    device->reference.renderer_epoch = epoch;
    result = std::move(device);
    return S_OK;
  }
};

RemoteAudioPlayout::RemoteAudioPlayout(AudioDeviceRegistry& devices)
    : devices_(devices), control_event_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {
  if (!control_event_) throw std::runtime_error("Remote audio control event creation failed");
  snapshot_.stopped = true;
  worker_ = std::thread([this] { run(); });
}
RemoteAudioPlayout::~RemoteAudioPlayout() {
  stop();
  CloseHandle(control_event_);
}
void RemoteAudioPlayout::changed() {
  ++revision_;
  SetEvent(control_event_);
}
void RemoteAudioPlayout::apply(std::uint64_t revision, const OutputIntent& intent, bool room_connected,
                               std::uint64_t device_revision) {
  std::lock_guard lock(mutex_);
  if (stopping_ || done_ || revision < desired_.revision) return;
  desired_ = {revision, device_revision, intent, room_connected};
  if (intent.state == OutputIntentState::on && room_connected) snapshot_.stopped = false;
  changed();
}
bool RemoteAudioPlayout::setScreenDemand(std::span<const RemoteVideoDemand> demand) {
  if (demand.size() > demand_.size()) return false;
  for (const auto& value : demand)
    if (!validIdentity(value.participant_identity) || !validIdentity(value.publication_id)) return false;
  std::lock_guard lock(mutex_);
  if (stopping_ || done_) return false;
  std::copy(demand.begin(), demand.end(), demand_.begin());
  for (auto index = demand.size(); index < demand_count_; ++index) demand_[index] = {};
  demand_count_ = demand.size();
  changed();
  return true;
}
RemoteAudioPlayoutSnapshot RemoteAudioPlayout::snapshot() const {
  std::lock_guard lock(mutex_);
  return snapshot_;
}
std::vector<std::string> RemoteAudioPlayout::activeSpeakerIdentities() const {
  std::vector<std::string> result;
  const auto now = Clock::now();
  std::lock_guard lock(mutex_);
  if (!connected_) return result;
  for (const auto& [identity, until] : speakers_)
    if (!identity.empty() && until > now &&
        std::find(result.begin(), result.end(), identity) == result.end()) result.push_back(identity);
  return result;
}
void RemoteAudioPlayout::beginStop() {
  std::lock_guard lock(mutex_);
  stopping_ = true;
  SetEvent(control_event_);
}
void RemoteAudioPlayout::stop() {
  std::lock_guard join_lock(join_mutex_);
  beginStop();
  {
    std::unique_lock lock(mutex_);
    // The SDK offers no cancellable reader destructor. A stuck native teardown
    // cannot turn shutdown into an unbounded wait; the utility process
    // boundary contains that terminal failure.
    if (!acknowledged_changed_.wait_for(lock, 5s, [&] { return done_; })) std::terminate();
  }
  if (worker_.joinable()) worker_.join();
}

bool RemoteAudioPlayout::isDesired(const Publication& value) const {
  if (!connected_ || !value.publication || value.failed) return false;
  if (value.publication->source() == livekit::TrackSource::SOURCE_MICROPHONE) return true;
  if (value.publication->source() != livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO) return false;
  // Screen audio plays only while its participant's current screen is watched.
  for (std::size_t index = 0; index < demand_count_; ++index) {
    const auto& demand = demand_[index];
    if (demand.participant_identity != value.participant) continue;
    for (const auto& video : publications_)
      if (video.participant == value.participant && video.publication &&
          video.publication->source() == livekit::TrackSource::SOURCE_SCREENSHARE &&
          video.publication->sid() == demand.publication_id) return true;
  }
  return false;
}
void RemoteAudioPlayout::clearRoom() {
  for (auto& value : publications_) value = {};
  connected_ = false;
  changed();
}
bool RemoteAudioPlayout::attachRoom(const std::shared_ptr<livekit::Room>& room) {
  if (!room || !detachRoom()) return false;
  std::lock_guard lock(mutex_);
  if (stopping_ || done_) return false;
  room_ = room;
  return true;
}
bool RemoteAudioPlayout::detachRoom() {
  std::unique_lock lock(mutex_);
  clearRoom();
  room_.reset();
  const auto revision = revision_;
  return acknowledged_changed_.wait_for(lock, 5s, [&] { return acknowledged_ >= revision || done_; });
}
bool RemoteAudioPlayout::seedConnectedRoom() {
  for (unsigned attempt = 0; attempt < 5; ++attempt) {
    std::shared_ptr<livekit::Room> room;
    std::uint64_t revision;
    {
      std::lock_guard lock(mutex_);
      if (!room_ || stopping_ || done_) return false;
      room = room_;
      revision = revision_;
    }
    const auto snapshot = room->remotePublications(kPublicationCapacity);
    const auto connected = room->connectionState() == livekit::ConnectionState::Connected;
    std::lock_guard lock(mutex_);
    if (room_ != room || stopping_ || done_) return false;
    if (revision_ != revision) continue;
    if (!connected) return false;
    connected_ = true;
    if (snapshot.truncated) ++rejected_;
    for (const auto& entry : snapshot.entries)
      if (entry.participant) addPublication(entry.participant->identity(), entry.publication);
    changed();
    return true;
  }
  return false;
}
void RemoteAudioPlayout::addPublication(std::string_view participant,
                                        const std::shared_ptr<livekit::RemoteTrackPublication>& publication) {
  if (!publication || !validIdentity(participant) || !validIdentity(publication->sid()) || !supported(*publication)) {
    ++rejected_;
    return;
  }
  for (const auto& value : publications_) {
    if (value.publication == publication) return;
    if (value.publication && value.publication->sid() == publication->sid()) {
      ++rejected_;
      return;
    }
  }
  const auto found = std::find_if(publications_.begin(), publications_.end(),
                                  [](const auto& value) { return !value.publication; });
  if (found == publications_.end()) {
    ++rejected_;
    return;
  }
  *found = {std::string(participant), publication, {}, ++next_generation_, false};
}
void RemoteAudioPlayout::onConnectionStateChanged(livekit::Room& room,
                                                  const livekit::ConnectionStateChangedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_) return;
  if (event.state == livekit::ConnectionState::Disconnected) return clearRoom();
  // SDK reconnection keeps publications and subscriptions. Keep readers and
  // their jitter buffers too, so audio resumes the moment media flows again.
  connected_ = true;
  changed();
}
void RemoteAudioPlayout::onTrackPublished(livekit::Room& room, const livekit::TrackPublishedEvent& event) {
  if (!event.participant) return;
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_) return;
  // Initial publication callbacks may precede the connected-state callback.
  connected_ = room.connectionState() == livekit::ConnectionState::Connected;
  addPublication(event.participant->identity(), event.publication);
  changed();
}
void RemoteAudioPlayout::onTrackUnpublished(livekit::Room& room, const livekit::TrackUnpublishedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant) return;
  for (auto& value : publications_)
    if (value.publication == event.publication && value.participant == event.participant->identity()) value = {};
  changed();
}
void RemoteAudioPlayout::onTrackSubscribed(livekit::Room& room, const livekit::TrackSubscribedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant || !event.track || !event.publication) return;
  for (auto& value : publications_)
    if (value.publication == event.publication && value.participant == event.participant->identity() &&
        event.track->kind() == livekit::TrackKind::KIND_AUDIO) {
      if (value.track == event.track) return;
      value.track = event.track;
      value.generation = ++next_generation_;
      changed();
      return;
    }
}
void RemoteAudioPlayout::onTrackUnsubscribed(livekit::Room& room, const livekit::TrackUnsubscribedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant) return;
  for (auto& value : publications_)
    if (value.publication == event.publication && value.track == event.track) {
      value.track.reset();
      value.generation = ++next_generation_;
    }
  changed();
}
void RemoteAudioPlayout::onTrackSubscriptionFailed(livekit::Room& room,
                                                   const livekit::TrackSubscriptionFailedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant) return;
  for (auto& value : publications_)
    if (value.publication && value.publication->sid() == event.track_sid &&
        value.participant == event.participant->identity()) {
      value.track.reset();
      value.failed = true;
      value.generation = ++next_generation_;
    }
  changed();
}
void RemoteAudioPlayout::onParticipantDisconnected(livekit::Room& room,
                                                   const livekit::ParticipantDisconnectedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant) return;
  for (auto& value : publications_)
    if (value.participant == event.participant->identity()) value = {};
  changed();
}

void RemoteAudioPlayout::run() noexcept {
  struct Reader {
    std::shared_ptr<livekit::RemoteTrackPublication> publication;
    std::shared_ptr<livekit::Track> track;
    std::unique_ptr<livekit::FreshAudioStream> stream;
    std::string participant;
    std::uint64_t generation = 0;
    bool subscribed = false, microphone = false;
    RemoteAudioJitter jitter;
    RemoteSpeakerActivity activity;
    std::uint64_t observed_dropped = 0, observed_stale = 0, ingress_age_us = 0;
    float volume = 1.0f, gain = 0.0f;
    bool muted = false;
  };
  // About 1 MB of jitter buffers: heap, not the default 1 MB thread stack.
  const auto reader_storage = std::make_unique<std::array<Reader, kPublicationCapacity>>();
  auto& readers = *reader_storage;
  std::unique_ptr<Device> device;
  RemoteAudioMixer mixer;
  RemoteAudioPlayoutStats stats;
  Desired applied;
  std::optional<EngineFailure> problem;
  Clock::time_point retry_at{}, next_tick = Clock::now(), last_render = Clock::now();
  std::uint64_t applied_revision = ~0ULL;
  std::uint32_t reported_delay_ms = 0;
  bool deafened = false, device_fallback = false;
  // Counters of released readers, so published totals never go backwards.
  RemoteAudioJitterStats retired_jitter;
  std::uint64_t retired_microphone_underruns = 0, retired_screen_audio_underruns = 0;
  const auto releaseReader = [&](Reader& reader) {
    if (reader.stream) {
      const auto value = reader.jitter.stats();
      retired_jitter.underruns += value.underruns;
      auto& source_underruns = reader.microphone ? retired_microphone_underruns : retired_screen_audio_underruns;
      source_underruns += value.underruns;
      retired_jitter.overruns += value.overruns;
      retired_jitter.trimmed += value.trimmed;
    }
    reader.stream.reset();
    reader.track.reset();
    reader.jitter = {};
    reader.activity = {};
    reader.observed_dropped = reader.observed_stale = reader.ingress_age_us = 0;
    reader.gain = 0.0f;
  };
  try {
    Apartment apartment;
    Mmcss mmcss;  // Scheduling hint only; absent when the MMCSS service is disabled.
    ExternalPlayout external_playout;
    for (;;) {
      const HANDLE events[]{control_event_, device ? device->event : nullptr};
      const auto wake = WaitForMultipleObjects(device ? 2 : 1, events, FALSE, device ? 50 : 10);
      if (wake == WAIT_FAILED) throw std::runtime_error("Remote audio wait failed");
      const auto now = Clock::now();

      // Control: subscriptions, mix settings and the desired device.
      std::array<Publication, kPublicationCapacity> publications;
      std::array<bool, kPublicationCapacity> wanted{};
      Desired desired;
      std::uint64_t revision;
      {
        std::lock_guard lock(mutex_);
        if (stopping_) break;
        revision = revision_;
        desired = desired_;
        if (revision != applied_revision) {
          publications = publications_;
          for (std::size_t index = 0; index < publications.size(); ++index) wanted[index] = isDesired(publications[index]);
        }
      }
      if (revision != applied_revision) {
        for (std::size_t index = 0; index < readers.size(); ++index) {
          auto& reader = readers[index];
          const auto& value = publications[index];
          if (reader.generation != value.generation || reader.track != value.track || !wanted[index]) releaseReader(reader);
          try {
            if (reader.publication != value.publication) {
              // Removed publications are already detached by the SDK. Never
              // send an operation through an old Room's publication handle.
              reader.publication = value.publication;
              reader.subscribed = false;
            }
            if (reader.publication && reader.subscribed != wanted[index] &&
                reader.publication->kind() == livekit::TrackKind::KIND_AUDIO) {
              reader.publication->setSubscribed(wanted[index]);
              reader.subscribed = wanted[index];
            }
            reader.generation = value.generation;
            reader.participant = value.participant;
            reader.microphone = reader.publication &&
                reader.publication->source() == livekit::TrackSource::SOURCE_MICROPHONE;
            if (wanted[index] && value.track && !reader.stream) {
              reader.track = value.track;
              reader.stream = std::make_unique<livekit::FreshAudioStream>(value.track);
            }
          } catch (...) {
            releaseReader(reader);
            std::lock_guard lock(mutex_);
            if (publications_[index].generation == value.generation) publications_[index].failed = true;
          }
          // Product volume (0..3) times participant or stream volume (0..3).
          reader.volume = static_cast<float>(desired.intent.state == OutputIntentState::on ? desired.intent.volume : 1);
          reader.muted = false;
          if (reader.publication) {
            const auto& controls = reader.publication->source() == livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO
                ? desired.intent.streams : desired.intent.users;
            for (const auto& control : controls)
              if (control.user_id == voiceUserId(reader.participant)) {
                reader.volume *= static_cast<float>(control.volume);
                reader.muted = control.muted;
                break;
              }
          }
        }
        deafened = desired.intent.state == OutputIntentState::on && desired.intent.deafened;
        applied_revision = revision;
        {
          std::lock_guard lock(mutex_);
          acknowledged_ = revision;
        }
        acknowledged_changed_.notify_all();
      }

      // Device: follow the selected endpoint or the multimedia default.
      const bool needed = desired.intent.state == OutputIntentState::on && desired.room_connected;
      const bool reselect = desired.device_revision != applied.device_revision ||
          desired.intent.device_id != applied.intent.device_id ||
          desired.intent.retry_revision != applied.intent.retry_revision || needed != applied.room_connected;
      if (!needed) {
        device.reset();
        problem.reset();
      } else if (reselect || (!device && now >= retry_at)) {
        auto endpoint = devices_.resolve(outputDevice(desired.intent));
        // A missing selected output (unplugged headset) plays on the default
        // output with a warning, and returns once the selected one is back.
        device_fallback = !endpoint && desired.intent.device_id.has_value();
        if (device_fallback) endpoint = devices_.resolve({AudioDirection::output, {}});
        if (!endpoint) {
          device.reset();
          problem = EngineFailure{"output_device_unavailable", "No output device is available", "output", true};
          retry_at = now + kDeviceRetry;
        } else if (!device || device->endpoint_id != endpoint->endpoint_id) {
          {
            std::lock_guard lock(mutex_);
            if (!device) snapshot_.path = {desired.revision, MediaPathState::Starting};
          }
          device.reset();
          std::unique_ptr<Device> opened;
          const auto status = Device::open(*endpoint, opened);
          if (SUCCEEDED(status)) {
            device = std::move(opened);
            ++stats.device_opens;
            problem.reset();
            last_render = Clock::now();
          } else {
            problem = EngineFailure{"output_device_failed", "Output device could not be opened", "output", true};
            retry_at = now + kDeviceRetry;
          }
        }
      }
      applied = {desired.revision, desired.device_revision, desired.intent, needed};

      const auto drainReaders = [&] {
        for (auto& reader : readers) {
          if (!reader.stream) continue;
          for (std::size_t count = 0; count < RemoteAudioJitter::kCapacity; ++count) {
            livekit::FreshAudioFrame decoded;
            const auto result = reader.stream->tryRead(decoded, 200'000);
            const auto sdk = reader.stream->stats();
            const auto dropped = sdk.dropped - reader.observed_dropped;
            stats.sdk_dropped += dropped;
            auto& source_dropped = reader.microphone ? stats.sdk_dropped_microphone : stats.sdk_dropped_screen_audio;
            source_dropped += dropped;
            stats.sdk_stale += sdk.stale - reader.observed_stale;
            reader.observed_dropped = sdk.dropped;
            reader.observed_stale = sdk.stale;
            if (result != livekit::FreshAudioReadResult::frame) break;
            ++stats.decoded;
            reader.ingress_age_us = decoded.age_us;
            if (decoded.discontinuity) {
              ++stats.sdk_discontinuities;
              auto& source_discontinuities = reader.microphone
                  ? stats.sdk_discontinuities_microphone : stats.sdk_discontinuities_screen_audio;
              ++source_discontinuities;
            }
            reader.jitter.push(decoded.samples);
            if (reader.microphone) reader.activity.observe(decoded.samples, Clock::now());
          }
        }
      };

      // Render: whole 10 ms frames until the 20 ms device buffer is full.
      std::array<RemoteAudioMixInput, kPublicationCapacity> inputs{};
      std::size_t input_count = 0;
      for (auto& reader : readers)
        if (reader.stream) inputs[input_count++] = {&reader.jitter, reader.volume, reader.muted, &reader.gain};
      const auto mixOne = [&](RemoteAudioFrame& frame) {
        // One device-clocked pull fills all track sinks synchronously. Drain
        // only here, so even a multi-frame wake gets new PCM for each mix.
        (void)livekit::pullAudioPlayout();
        drainReaders();
        (void)mixer.mix(std::span(inputs.data(), input_count), deafened, frame);
      };
      RemoteAudioFrame frame;
      std::uint32_t device_buffered_ms = 0;
      if (device) {
        try {
          UINT32 padding = 0;
          HRESULT status = device->client->GetCurrentPadding(&padding);
          if (SUCCEEDED(status) && padding == 0) ++stats.device_starved;
          if (now - last_render > 30ms) ++stats.late_wakes;
          while (SUCCEEDED(status) && device->buffer_frames - padding >= kRemoteAudioFrames) {
            mixOne(frame);
            BYTE* data = nullptr;
            status = device->render->GetBuffer(static_cast<UINT32>(kRemoteAudioFrames), &data);
            if (FAILED(status)) break;
            std::copy(frame.begin(), frame.end(), reinterpret_cast<std::int16_t*>(data));
            status = device->render->ReleaseBuffer(static_cast<UINT32>(kRemoteAudioFrames), 0);
            if (FAILED(status)) break;
            ++stats.rendered_frames;
            // Echo reference: exactly what was handed to the device, downmixed.
            auto& reference = device->reference;
            for (std::size_t index = 0; index < kRemoteAudioFrames; ++index)
              reference.samples[index] = static_cast<std::int16_t>(
                  (static_cast<std::int32_t>(frame[index * 2]) + frame[index * 2 + 1]) / 2);
            ++reference.sequence;
            reference.rendered_timestamp_100ns = timestamp100ns();
            reference.stream_delay_ms = (std::min)(500U, device->latency_ms + padding / 48);
            (void)device->echo->publish(reference);
            padding += static_cast<UINT32>(kRemoteAudioFrames);
            last_render = Clock::now();
          }
          device_buffered_ms = padding / (kRemoteAudioRate / 1000);
          if (FAILED(status)) {
            device.reset();
            problem = EngineFailure{"output_device_lost", "Output device stopped rendering", "output", true};
            retry_at = Clock::now() + 250ms;
          } else if (Clock::now() - last_render > 500ms) {
            device.reset();
            problem = EngineFailure{"output_device_stalled", "Output device stopped consuming audio", "output", true};
            retry_at = Clock::now();
          }
        } catch (...) {
          device.reset();
          problem = EngineFailure{"output_device_lost", "Output device stopped rendering", "output", true};
          retry_at = Clock::now() + 250ms;
        }
      } else {
        // No device: drive WebRTC every 10 ms so speaker activity and jitter
        // state stay current, without letting a backlog build up.
        for (unsigned count = 0; now >= next_tick && count < 2; ++count) {
          mixOne(frame);
          next_tick += 10ms;
        }
        if (now >= next_tick) next_tick = now + 10ms;
      }

      // Publish observations.
      // Remote audio is heard this long after the SDK hands it over: its
      // decoded-ingress queue, our jitter buffer and the output device.
      // WebRTC's audio/video sync subtracts it, so screen pictures wait for
      // the sound actually heard.
      std::uint32_t queued_ms = 0;
      for (const auto& reader : readers)
        if (reader.stream)
          queued_ms = (std::max)(queued_ms, static_cast<std::uint32_t>(reader.ingress_age_us / 1000) +
                                                reader.jitter.stats().depth * 10);
      const std::uint32_t output_delay_ms = device ? device->latency_ms + device_buffered_ms + queued_ms : 0;
      if (output_delay_ms + 5 < reported_delay_ms || output_delay_ms > reported_delay_ms + 5 ||
          (!output_delay_ms && reported_delay_ms)) {
        reported_delay_ms = output_delay_ms;
        livekit::setAudioPlayoutDelay(std::chrono::milliseconds{reported_delay_ms});
      }
      RemoteAudioJitterStats jitter = retired_jitter;
      stats.jitter_underruns_microphone = retired_microphone_underruns;
      stats.jitter_underruns_screen_audio = retired_screen_audio_underruns;
      for (auto& reader : readers) {
        if (!reader.stream) continue;
        const auto value = reader.jitter.stats();
        jitter.underruns += value.underruns;
        auto& source_underruns = reader.microphone ? stats.jitter_underruns_microphone : stats.jitter_underruns_screen_audio;
        source_underruns += value.underruns;
        jitter.overruns += value.overruns;
        jitter.trimmed += value.trimmed;
      }
      stats.jitter_underruns = jitter.underruns;
      stats.jitter_overruns = jitter.overruns;
      stats.jitter_trimmed = jitter.trimmed;
      stats.reading = static_cast<std::uint32_t>(input_count);
      stats.device_open = device != nullptr;
      stats.latency_ms = output_delay_ms;
      {
        std::lock_guard lock(mutex_);
        for (std::size_t index = 0; index < readers.size(); ++index) {
          const auto& reader = readers[index];
          if (index < speakers_.size()) {
            // A deafened listener hears nobody, so nobody is shown speaking.
            speakers_[index] = reader.stream && reader.microphone && !deafened
                ? std::pair{reader.participant, reader.activity.speakingUntil()}
                : std::pair{std::string{}, Clock::time_point{}};
          }
        }
        snapshot_.stats = stats;
        snapshot_.echo = device ? device->echo : nullptr;
        snapshot_.stopped = !device;
        snapshot_.path.revision = desired.revision;
        snapshot_.path.failure = problem;
        snapshot_.path.warning = false;
        if (device && device_fallback && !problem) {
          snapshot_.path.failure = EngineFailure{"output_device_fallback",
              "Selected output is unavailable; using the default output", "output", true};
          snapshot_.path.warning = true;
        }
        snapshot_.path.state = !needed ? MediaPathState::Off :
            device ? (deafened ? MediaPathState::Muted : MediaPathState::Running) :
            problem ? MediaPathState::Failed : MediaPathState::Starting;
      }
    }
  } catch (...) {
    std::lock_guard lock(mutex_);
    snapshot_.path = {applied.revision, MediaPathState::Failed,
                      EngineFailure{"output_owner_failed", "Remote audio playout failed", "output", false}};
  }
  device.reset();
  if (reported_delay_ms) livekit::setAudioPlayoutDelay(std::chrono::milliseconds{0});
  for (auto& reader : readers) {
    releaseReader(reader);
    reader.publication.reset();
  }
  {
    std::lock_guard lock(mutex_);
    for (auto& value : publications_) value = {};
    room_.reset();
    connected_ = false;
    snapshot_.echo.reset();
    snapshot_.stopped = true;
    done_ = true;
    acknowledged_ = revision_;
  }
  acknowledged_changed_.notify_all();
}
}  // namespace syrnike::windows_media::audio
