#pragma once

#include <napi.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>

#include "event_sink.hpp"

namespace syrnike::desktop_native {

class CoalescingEventLane;
class ControlEventLane;

Napi::Object serializeRuntimeEventForContractTest(
  Napi::Env env,
  const RuntimeEvent& event
);

class NodeEventSink final : public EventSink {
 public:
  NodeEventSink(Napi::Env env, Napi::Function callback, const char* resource_name);
  ~NodeEventSink() override;

  bool emit(RuntimeEvent event) override;
  void close() override;

 private:
  void scheduleRuntimeLoss(
    std::uint64_t sequence,
    const char* reason
  ) noexcept;

  std::atomic_bool closed_{false};
  std::mutex lifecycle_mutex_;
  std::mutex fatal_mutex_;
  std::unique_ptr<RuntimeEvent> fatal_payload_;
  bool fatal_scheduled_ = false;
  Napi::ThreadSafeFunction control_callback_;
  Napi::ThreadSafeFunction media_callback_;
  Napi::ThreadSafeFunction metrics_callback_;
  Napi::ThreadSafeFunction realtime_callback_;
  Napi::ThreadSafeFunction fatal_callback_;
  std::shared_ptr<ControlEventLane> control_lane_;
  std::shared_ptr<CoalescingEventLane> media_lane_;
  std::shared_ptr<CoalescingEventLane> realtime_lane_;
};

}  // namespace syrnike::desktop_native
