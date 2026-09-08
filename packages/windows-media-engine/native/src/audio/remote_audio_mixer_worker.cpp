#include "audio/remote_audio_mixer_worker.hpp"

#include <windows.h>
#include <avrt.h>
#include <algorithm>
#include <stdexcept>

namespace syrnike::windows_media::audio {
namespace {
using Clock = std::chrono::steady_clock;
struct Event {
  HANDLE value;
  explicit Event(bool manual = false) : value(CreateEventW(nullptr, manual, FALSE, nullptr)) {
    if (!value) throw std::runtime_error("Mixer event creation failed");
  }
  ~Event() { CloseHandle(value); }
};
struct Timer {
  HANDLE value = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
  Timer() {
    if (!value) throw std::runtime_error("Mixer timer creation failed");
  }
  ~Timer() { CancelWaitableTimer(value); CloseHandle(value); }
};
struct Mmcss {
  DWORD task = 0;
  HANDLE value = AvSetMmThreadCharacteristicsW(L"Audio", &task);
  ~Mmcss() { if (value) AvRevertMmThreadCharacteristics(value); }
};
std::int64_t timestamp() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
DWORD remaining(Clock::time_point deadline) noexcept {
  return static_cast<DWORD>((std::clamp)(
      std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count(),
      std::int64_t{0}, std::int64_t{5000}));
}
struct InputCommand {
  std::array<RemoteAudioInput, kRemoteAudioTrackCapacity> inputs{};
  std::size_t count = 0;
  bool deafened = false;
};
struct OutputCommand {
  std::shared_ptr<RemoteAudioPcmPort> port;
  std::int64_t minimum_timestamp = 0;
};

template <typename Command>
struct CommandSlot {
  Event changed, acknowledged;
  std::atomic_flag producer_busy = ATOMIC_FLAG_INIT;
  std::atomic_uint64_t posted{0}, applied{0};
  std::atomic_bool accepted{false};
  Command pending;
  Command retained;

  bool post(Command command, std::atomic_bool& retired, HANDLE done) {
    if (producer_busy.test_and_set(std::memory_order_acquire)) return false;
    struct Release {
      std::atomic_flag& flag;
      ~Release() { flag.clear(std::memory_order_release); }
    } release{producer_busy};
    if (retired.load(std::memory_order_acquire)) return false;
    pending = std::move(command);
    const auto revision = posted.load(std::memory_order_relaxed) + 1;
    posted.store(revision, std::memory_order_release);
    SetEvent(changed.value);
    const auto deadline = Clock::now() + std::chrono::seconds(1);
    const HANDLE events[]{acknowledged.value, done};
    while (applied.load(std::memory_order_acquire) != revision) {
      if (WaitForMultipleObjects(2, events, FALSE, remaining(deadline)) != WAIT_OBJECT_0) {
        retired.store(true, std::memory_order_release);
        return false;
      }
    }
    const bool result = accepted.load(std::memory_order_relaxed);
    // All shared_ptr destruction happens on this control caller, after the
    // worker stopped touching pending. The worker keeps only borrowed ports.
    if (result) retained = std::move(pending);
    pending = {};
    return result;
  }
  void acknowledge(std::uint64_t revision, bool result) noexcept {
    accepted.store(result, std::memory_order_relaxed);
    applied.store(revision, std::memory_order_release);
    SetEvent(acknowledged.value);
  }
};
}  // namespace

struct RemoteAudioMixerWorker::State {
  Event stop{true}, ready{true}, done{true};
  CommandSlot<InputCommand> inputs;
  CommandSlot<OutputCommand> output;
  std::atomic_bool retired{false}, initialized{false};
  std::atomic_uint64_t frames{0}, source_frames{0}, discontinuities{0}, limited_frames{0};
  std::atomic<std::int64_t> maximum_age{0};
  std::array<std::atomic_uint64_t, 7> age_histogram{};
  std::atomic_uint32_t count{0};
};

RemoteAudioMixerWorker::RemoteAudioMixerWorker() : state_(std::make_shared<State>()) {
  worker_ = std::thread([state = state_] { run(state); });
  if (WaitForSingleObject(state_->ready.value, 5000) != WAIT_OBJECT_0 || !state_->initialized.load()) {
    if (!stop(Clock::now() + std::chrono::seconds(5))) std::terminate();
    throw std::runtime_error("Mixer worker initialization failed");
  }
}
RemoteAudioMixerWorker::~RemoteAudioMixerWorker() {
  if (!stop(Clock::now() + std::chrono::seconds(5))) std::terminate();
}
bool RemoteAudioMixerWorker::configure(std::span<const RemoteAudioInput> inputs, bool deafened) {
  if (inputs.size() > kRemoteAudioTrackCapacity) return false;
  InputCommand command;
  command.count = inputs.size();
  command.deafened = deafened;
  std::copy(inputs.begin(), inputs.end(), command.inputs.begin());
  return state_->inputs.post(std::move(command), state_->retired, state_->done.value);
}
bool RemoteAudioMixerWorker::bindOutput(std::shared_ptr<RemoteAudioPcmPort> output, std::int64_t minimum_timestamp) {
  if (output && (!output->active() || !output->generation() || minimum_timestamp <= 0)) return false;
  return state_->output.post(OutputCommand{std::move(output), minimum_timestamp}, state_->retired, state_->done.value);
}
bool RemoteAudioMixerWorker::stop(Clock::time_point deadline) noexcept {
  state_->retired.store(true, std::memory_order_release);
  SetEvent(state_->stop.value);
  if (worker_.joinable()) {
    if (WaitForSingleObject(state_->done.value, remaining(deadline)) != WAIT_OBJECT_0) return false;
    worker_.join();
  }
  return true;
}
bool RemoteAudioMixerWorker::retired() const noexcept { return state_->retired.load(); }
RemoteAudioMixStats RemoteAudioMixerWorker::stats() const noexcept {
  RemoteAudioMixStats result;
  result.frames = state_->frames.load();
  result.source_frames = state_->source_frames.load();
  result.discontinuities = state_->discontinuities.load();
  result.limited_frames = state_->limited_frames.load();
  result.maximum_age_100ns = state_->maximum_age.load();
  result.inputs = state_->count.load();
  for (std::size_t index = 0; index < result.age_histogram.size(); ++index)
    result.age_histogram[index] = state_->age_histogram[index].load();
  return result;
}
void RemoteAudioMixerWorker::run(const std::shared_ptr<State>& state) noexcept {
  try {
    Mmcss mmcss;
    if (!mmcss.value) throw std::runtime_error("Mixer MMCSS registration failed");
    Timer timer;
    LARGE_INTEGER due{};
    due.QuadPart = -100'000;
    if (!SetWaitableTimer(timer.value, &due, 10, nullptr, nullptr, FALSE))
      throw std::runtime_error("Mixer timer start failed");
    RemoteAudioMixer mixer;
    RemoteAudioPcmPort* output = nullptr;
    std::int64_t minimum_timestamp = 0;
    const HANDLE events[]{state->stop.value, state->inputs.changed.value, state->output.changed.value, timer.value};
    state->initialized = true;
    SetEvent(state->ready.value);
    while (!state->retired.load(std::memory_order_acquire)) {
      const auto wake = WaitForMultipleObjects(4, events, FALSE, 1000);
      if (wake == WAIT_OBJECT_0) break;
      if (wake == WAIT_OBJECT_0 + 1) {
        auto& slot = state->inputs;
        const auto revision = slot.posted.load(std::memory_order_acquire);
        const auto& command = slot.pending;
        std::array<RemoteAudioMixInput, kRemoteAudioTrackCapacity> inputs{};
        for (std::size_t index = 0; index < command.count; ++index)
          inputs[index] = {command.inputs[index].port.get(), command.inputs[index].volume, command.inputs[index].muted};
        const bool accepted = mixer.setInputs(std::span(inputs).first(command.count));
        if (accepted) mixer.setDeafened(command.deafened);
        slot.acknowledge(revision, accepted);
      } else if (wake == WAIT_OBJECT_0 + 2) {
        auto& slot = state->output;
        const auto revision = slot.posted.load(std::memory_order_acquire);
        output = slot.pending.port.get();
        minimum_timestamp = slot.pending.minimum_timestamp;
        slot.acknowledge(revision, true);
      } else if (wake != WAIT_OBJECT_0 + 3) {
        throw std::runtime_error("Mixer worker wait failed");
      }
      // Process a due frame even during control traffic. Missed timer periods
      // coalesce; there is no catch-up loop that could replay buffered audio.
      if (wake != WAIT_OBJECT_0 + 3 && WaitForSingleObject(timer.value, 0) != WAIT_OBJECT_0) continue;
      const auto frame = mixer.mix(timestamp(), minimum_timestamp, output ? output->generation() : 0);
      if (output) (void)output->publish(frame);
      const auto stats = mixer.stats();
      state->frames = stats.frames;
      state->source_frames = stats.source_frames;
      state->discontinuities = stats.discontinuities;
      state->limited_frames = stats.limited_frames;
      state->maximum_age = stats.maximum_age_100ns;
      state->count = stats.inputs;
      for (std::size_t index = 0; index < stats.age_histogram.size(); ++index)
        state->age_histogram[index] = stats.age_histogram[index];
    }
  } catch (...) { state->retired.store(true, std::memory_order_release); }
  SetEvent(state->ready.value);
  SetEvent(state->done.value);
}
}  // namespace syrnike::windows_media::audio
