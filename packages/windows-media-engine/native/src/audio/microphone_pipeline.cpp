#include "audio/microphone_pipeline.hpp"
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
    if (!value) throw std::runtime_error("Microphone pipeline event creation failed");
  }
  ~Event() { CloseHandle(value); }
};
struct Mmcss {
  DWORD task = 0;
  HANDLE handle = AvSetMmThreadCharacteristicsW(L"Audio", &task);
  ~Mmcss() { if (handle) AvRevertMmThreadCharacteristics(handle); }
};
DWORD remaining(Clock::time_point deadline) noexcept {
  return static_cast<DWORD>((std::clamp)(
      std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count(),
      std::int64_t{0}, std::int64_t{5000}));
}
std::int64_t timestamp() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
}  // namespace
struct MicrophonePipeline::State {
  enum class CommandKind { input, config, echo_reference };
  struct Command {
    CommandKind kind = CommandKind::input;
    MicrophonePcmPort* input = nullptr;
    HANDLE frame_event = nullptr;
    std::uint64_t generation = 0;
    MicrophoneDspConfig config;
    EchoReferencePort* echo_reference = nullptr;
  } command;
  Event control, acknowledged, ready{true}, stop{true}, done{true}, output_event;
  std::atomic<std::uint64_t> posted{0}, applied{0};
  std::atomic<bool> initialized{false}, command_ok{false}, failed{false};
  std::shared_ptr<MicrophonePcmPort> output = std::make_shared<MicrophonePcmPort>();
  std::atomic<std::uint64_t> output_frames{0}, stale_frames{0};
  // Meter has the same triple-buffer ownership protocol as PCM, at 10 Hz.
  std::array<MicrophoneDspStats, 3> meters{};
  std::atomic<unsigned> meter_middle{1};
  unsigned meter_write = 2, meter_read = 0;
  void publishMeter(const MicrophoneDspStats& value) noexcept {
    meters[meter_write] = value;
    meter_write = meter_middle.exchange(meter_write | 4, std::memory_order_acq_rel) & 3;
  }
  void readMeter(MicrophoneDspStats& value) noexcept {
    if (!(meter_middle.load(std::memory_order_acquire) & 4)) return;
    meter_read = meter_middle.exchange(meter_read, std::memory_order_acq_rel) & 3;
    value = meters[meter_read];
  }
};
MicrophonePipeline::MicrophonePipeline(EnhancementFactory factory) : state_(std::make_shared<State>()) {
  if (!factory) throw std::invalid_argument("Microphone enhancement factory missing");
  worker_ = std::thread([state = state_, factory] { run(state, factory); });
  if (WaitForSingleObject(state_->ready.value, 5000) != WAIT_OBJECT_0 || !state_->initialized.load()) {
    if (!stop(Clock::now() + std::chrono::seconds{5})) std::terminate();
    throw std::runtime_error("Microphone DSP worker initialization failed");
  }
}
MicrophonePipeline::~MicrophonePipeline() {
  if (!stop(Clock::now() + std::chrono::seconds{5})) std::terminate();
}
bool MicrophonePipeline::onOwner() const noexcept {
  return owner_ == std::this_thread::get_id() && !stats_.retired && !state_->failed.load();
}
bool MicrophonePipeline::submit() noexcept {
  // Only the control thread writes the slot, and only after the last acquire
  // acknowledgement. The worker releases its acknowledgement after its last
  // slot access. A timeout forbids reuse and keeps borrowed captures alive.
  const auto revision = ++command_revision_;
  state_->posted.store(revision, std::memory_order_release);
  SetEvent(state_->control.value);
  const auto deadline = Clock::now() + std::chrono::seconds{1};
  while (state_->applied.load(std::memory_order_acquire) != revision) {
    if (WaitForSingleObject(state_->acknowledged.value, remaining(deadline)) != WAIT_OBJECT_0) {
      stats_.retired = true;
      return false;
    }
  }
  return state_->command_ok.load(std::memory_order_relaxed);
}
bool MicrophonePipeline::commitInput(MicrophoneCapture* capture) noexcept {
  state_->command.kind = State::CommandKind::input;
  state_->command.input = capture ? capture->pcm().get() : nullptr;
  state_->command.frame_event = capture ? capture->frameEvent() : nullptr;
  state_->command.generation = capture ? capture->stats().generation : 0;
  return submit();
}
MicrophonePipelineFailure MicrophonePipeline::switchCapture(const AudioEndpoint& endpoint, bool bypass_system_processing,
                                                           std::stop_token cancellation) {
  if (cancellation.stop_requested()) return MicrophonePipelineFailure::cancelled;
  candidate_ = std::make_unique<MicrophoneCapture>();
  ++stats_.capture_opens;
  stats_.candidate_failure = candidate_->start(endpoint, ++generation_, bypass_system_processing, cancellation);
  if (stats_.candidate_failure != MicrophoneCaptureFailure::none || cancellation.stop_requested()) {
    if (!candidate_->stop(Clock::now() + std::chrono::seconds{5})) {
      stats_.retired = true;
      return MicrophonePipelineFailure::stop_timeout;
    }
    candidate_.reset();
    return cancellation.stop_requested() ? MicrophonePipelineFailure::cancelled : MicrophonePipelineFailure::capture_failed;
  }
  // Admission to the serialized DSP commit follows the cancellation check.
  // A newer desired state after admission is the next capture transaction.
  if (!commitInput(candidate_.get())) return MicrophonePipelineFailure::command_timeout;
  // After acknowledgement the worker no longer references active's port/event.
  if (active_ && !active_->stop(Clock::now() + std::chrono::seconds{5})) {
    stats_.retired = true;
    return MicrophonePipelineFailure::stop_timeout;
  }
  active_ = std::move(candidate_);
  ++stats_.committed_switches;
  return MicrophonePipelineFailure::none;
}
MicrophonePipelineFailure MicrophonePipeline::selectInput(AudioEndpoint endpoint, std::stop_token cancellation) {
  if (!onOwner() || endpoint.direction != AudioDirection::input || endpoint.endpoint_id.empty())
    return MicrophonePipelineFailure::invalid_state;
  if (cancellation.stop_requested()) return MicrophonePipelineFailure::cancelled;
  if (selected_ && selected_->endpoint_id == endpoint.endpoint_id && active_ &&
      active_->stats().state == MicrophoneCaptureState::healthy) return MicrophonePipelineFailure::none;
  if (stats_.demand.needed()) {
    const auto failure = switchCapture(endpoint, bypass_system_processing_, cancellation);
    if (failure != MicrophonePipelineFailure::none) return failure;
  }
  selected_ = std::move(endpoint);
  return MicrophonePipelineFailure::none;
}
MicrophonePipelineFailure MicrophonePipeline::selectInput(AudioDeviceRegistry& registry, AudioDeviceIntent intent,
                                                         std::stop_token cancellation) {
  if (!onOwner() || intent.direction != AudioDirection::input) return MicrophonePipelineFailure::invalid_state;
  const auto endpoint = registry.resolve(intent);
  if (!endpoint) return MicrophonePipelineFailure::input_unavailable;
  const auto failure = selectInput(*endpoint, cancellation);
  if (failure == MicrophonePipelineFailure::none) input_intent_ = intent;
  return failure;
}
MicrophonePipelineFailure MicrophonePipeline::reconcileInput(AudioDeviceRegistry& registry, std::stop_token cancellation) {
  return selectInput(registry, input_intent_, cancellation);
}
MicrophonePipelineFailure MicrophonePipeline::setDemand(MicrophoneDemand demand, std::stop_token cancellation) {
  if (!onOwner()) return MicrophonePipelineFailure::invalid_state;
  if (cancellation.stop_requested()) return MicrophonePipelineFailure::cancelled;
  if (demand.needed() && !active_) {
    if (!selected_) return MicrophonePipelineFailure::input_unavailable;
    const auto failure = switchCapture(*selected_, bypass_system_processing_, cancellation);
    if (failure != MicrophonePipelineFailure::none) return failure;
  } else if (!demand.needed() && active_) {
    if (!commitInput(nullptr)) return MicrophonePipelineFailure::command_timeout;
    if (!active_->stop(Clock::now() + std::chrono::seconds{5})) {
      stats_.retired = true;
      return MicrophonePipelineFailure::stop_timeout;
    }
    active_.reset();
  }
  stats_.demand = demand;
  return MicrophonePipelineFailure::none;
}
MicrophonePipelineFailure MicrophonePipeline::setSystemProcessingBypass(bool bypass, std::stop_token cancellation) {
  if (!onOwner()) return MicrophonePipelineFailure::invalid_state;
  if (cancellation.stop_requested()) return MicrophonePipelineFailure::cancelled;
  if (bypass == bypass_system_processing_) return MicrophonePipelineFailure::none;
  if (active_ && selected_) {
    const auto failure = switchCapture(*selected_, bypass, cancellation);
    if (failure != MicrophonePipelineFailure::none) return failure;
  }
  bypass_system_processing_ = bypass;
  return MicrophonePipelineFailure::none;
}
MicrophonePipelineFailure MicrophonePipeline::configure(const MicrophoneDspConfig& config) {
  if (!onOwner()) return MicrophonePipelineFailure::invalid_state;
  state_->command.kind = State::CommandKind::config;
  state_->command.config = config;
  if (submit()) return MicrophonePipelineFailure::none;
  return stats_.retired ? MicrophonePipelineFailure::command_timeout : MicrophonePipelineFailure::invalid_state;
}
MicrophonePipelineFailure MicrophonePipeline::setEchoReference(std::shared_ptr<EchoReferencePort> reference) {
  if (!onOwner()) return MicrophonePipelineFailure::invalid_state;
  if (reference == echo_reference_) return MicrophonePipelineFailure::none;
  pending_echo_reference_ = std::move(reference);
  state_->command.kind = State::CommandKind::echo_reference;
  state_->command.echo_reference = pending_echo_reference_.get();
  // Keep both projections alive if acknowledgement times out. As with input
  // captures, the retired pipeline cannot reuse this command slot before join.
  if (!submit()) return MicrophonePipelineFailure::command_timeout;
  echo_reference_ = std::move(pending_echo_reference_);
  return MicrophonePipelineFailure::none;
}
MicrophonePipelineStats MicrophonePipeline::stats() {
  if (owner_ != std::this_thread::get_id()) throw std::logic_error("Microphone pipeline owner mismatch");
  stats_.capture = active_ ? active_->stats() : MicrophoneCaptureStats{};
  state_->readMeter(stats_.meter);
  if (stats_.capture.state != MicrophoneCaptureState::healthy || stats_.retired || state_->failed.load()) {
    // A stopped/lost input must not keep its last speaking indication alive.
    // Preserve counters/config diagnostics while projecting no live signal.
    stats_.meter.input_level = 0;
    stats_.meter.output_level = 0;
    stats_.meter.speaking = false;
    stats_.meter.gate_open = false;
    stats_.meter.echo = EchoAvailability::unavailable;
  }
  stats_.output_frames = state_->output_frames.load(std::memory_order_relaxed);
  stats_.stale_frames = state_->stale_frames.load(std::memory_order_relaxed);
  stats_.retired = stats_.retired || state_->failed.load();
  return stats_;
}
bool MicrophonePipeline::stop(Clock::time_point deadline) noexcept {
  if (owner_ != std::this_thread::get_id()) return false;
  stats_.retired = true;
  SetEvent(state_->stop.value);
  if (worker_.joinable()) {
    if (WaitForSingleObject(state_->done.value, remaining(deadline)) != WAIT_OBJECT_0) return false;
    worker_.join();
  }
  if (candidate_ && !candidate_->stop(deadline)) return false;
  if (active_ && !active_->stop(deadline)) return false;
  candidate_.reset();
  active_.reset();
  pending_echo_reference_.reset();
  echo_reference_.reset();
  return true;
}
std::shared_ptr<MicrophonePcmPort> MicrophonePipeline::output() const noexcept { return state_->output; }
void* MicrophonePipeline::outputEvent() const noexcept { return state_->output_event.value; }

void MicrophonePipeline::run(const std::shared_ptr<State>& state, EnhancementFactory factory) noexcept {
  try {
    MicrophoneDsp dsp(factory());
    Mmcss mmcss;
    if (!mmcss.handle) throw std::runtime_error("Microphone DSP MMCSS registration failed");
    MicrophonePcmPort* input = nullptr;
    EchoReferencePort* echo_reference = nullptr;
    HANDLE frame_event = nullptr;
    std::uint64_t generation = 0;
    auto next_meter = Clock::now();
    state->initialized.store(true);
    SetEvent(state->ready.value);
    for (;;) {
      const HANDLE events[]{state->stop.value, state->control.value, frame_event};
      const auto result = WaitForMultipleObjects(frame_event ? 3 : 2, events, FALSE, INFINITE);
      if (result == WAIT_OBJECT_0) break;
      if (result == WAIT_OBJECT_0 + 1) {
        const auto revision = state->posted.load(std::memory_order_acquire);
        const auto& command = state->command;
        bool accepted = true;
        if (command.kind == State::CommandKind::config) accepted = dsp.configure(revision, command.config);
        else if (command.kind == State::CommandKind::echo_reference) echo_reference = command.echo_reference;
        else {
          input = command.input;
          frame_event = command.frame_event;
          generation = command.generation;
        }
        state->command_ok.store(accepted, std::memory_order_relaxed);
        state->applied.store(revision, std::memory_order_release);
        SetEvent(state->acknowledged.value);
        continue;
      }
      if (result != WAIT_OBJECT_0 + 2) throw std::runtime_error("Microphone DSP wait failed");
      auto frame = input->take();
      if (!frame) continue;
      const auto now = timestamp();
      if (frame->generation != generation || frame->timestamp_100ns <= 0 || frame->timestamp_100ns > now ||
          now - frame->timestamp_100ns > kMicrophoneMaximumAge100ns) {
        state->stale_frames.fetch_add(1, std::memory_order_relaxed);
        continue;
      }
      dsp.process(*frame, now, echo_reference);
      state->output->publish(*frame);
      state->output_frames.fetch_add(1, std::memory_order_relaxed);
      SetEvent(state->output_event.value);
      if (Clock::now() >= next_meter) {
        state->publishMeter(dsp.stats());
        next_meter = Clock::now() + std::chrono::milliseconds{100};
      }
    }
  } catch (...) { state->failed.store(true); }
  SetEvent(state->ready.value);
  SetEvent(state->output_event.value);
  SetEvent(state->done.value);
}
}  // namespace syrnike::windows_media::audio
