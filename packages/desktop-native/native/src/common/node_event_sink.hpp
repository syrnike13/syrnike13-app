#pragma once

#include <napi.h>

#include <atomic>
#include <mutex>

#include "event_sink.hpp"

namespace syrnike::desktop_native {

class NodeEventSink final : public EventSink {
 public:
  NodeEventSink(Napi::Env env, Napi::Function callback, const char* resource_name);
  ~NodeEventSink() override;

  bool emit(RuntimeEvent event) override;
  void close() override;

 private:
  std::atomic_bool closed_{false};
  std::mutex lifecycle_mutex_;
  Napi::ThreadSafeFunction control_callback_;
  Napi::ThreadSafeFunction realtime_callback_;
};

}  // namespace syrnike::desktop_native
