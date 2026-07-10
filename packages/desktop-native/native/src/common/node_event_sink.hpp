#pragma once

#include <napi.h>

#include <atomic>
#include <memory>

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
  Napi::ThreadSafeFunction control_callback_;
  Napi::ThreadSafeFunction metrics_callback_;
};

}  // namespace syrnike::desktop_native
