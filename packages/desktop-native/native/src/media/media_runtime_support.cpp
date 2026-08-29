#include "media_runtime_support.hpp"

#include <livekit/livekit.h>

#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <string_view>
#include <utility>

#include "../common/diagnostic_log.hpp"

namespace syrnike::desktop_native::media {
namespace {

std::atomic_uint32_t active_livekit_leases{0};
std::atomic_uint32_t livekit_initialize_transitions{0};
std::atomic_uint32_t livekit_shutdown_transitions{0};
std::mutex livekit_runtime_mutex;

void logLiveKitRuntime(std::string_view event) {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (logger.enabled()) logger.write(event);
}

}  // namespace

LiveKitLease::LiveKitLease() {
  std::lock_guard lock(livekit_runtime_mutex);
  const auto active =
    active_livekit_leases.load(std::memory_order_relaxed);
  if (active != 0) {
    active_livekit_leases.store(active + 1, std::memory_order_release);
    return;
  }
  logLiveKitRuntime("media_runtime_livekit_initialize_start");
  bool initialized = false;
  try {
    if (!livekit::initialize(livekit::LogLevel::Off)) {
      logLiveKitRuntime("media_runtime_livekit_initialize_failed");
      throw std::runtime_error("LiveKit initialization failed");
    }
    initialized = true;
    auto& logger = diagnostics::DiagnosticLog::instance();
    if (logger.enabled()) {
      livekit::setLogLevel(livekit::LogLevel::Trace);
      livekit::setLogCallback([](
        livekit::LogLevel level,
        const std::string& logger_name,
        const std::string& message
      ) {
        diagnostics::DiagnosticLog::instance().write(
          "media_runtime_livekit_trace",
          {
            {"logger", logger_name},
            {"level", static_cast<std::uint64_t>(level)},
            {"message", message}
          }
        );
      });
    }
    logLiveKitRuntime("media_runtime_livekit_initialize_ok");
  } catch (...) {
    if (initialized) {
      try { livekit::setLogCallback({}); } catch (...) {}
      try { livekit::shutdown(); } catch (...) {}
    }
    throw;
  }
  livekit_initialize_transitions.fetch_add(1, std::memory_order_release);
  active_livekit_leases.store(1, std::memory_order_release);
}

LiveKitLease::~LiveKitLease() {
  std::lock_guard lock(livekit_runtime_mutex);
  const auto active =
    active_livekit_leases.load(std::memory_order_relaxed);
  if (active == 0) return;
  if (active > 1) {
    active_livekit_leases.store(active - 1, std::memory_order_release);
    return;
  }
  try { logLiveKitRuntime("media_runtime_livekit_shutdown_start"); } catch (...) {}
  try {
    if (diagnostics::DiagnosticLog::instance().enabled()) {
      livekit::setLogCallback({});
    }
  } catch (...) {}
  try { livekit::shutdown(); } catch (...) {}
  livekit_shutdown_transitions.fetch_add(1, std::memory_order_release);
  active_livekit_leases.store(0, std::memory_order_release);
  try { logLiveKitRuntime("media_runtime_livekit_shutdown_done"); } catch (...) {}
}

bool LiveKitLease::active() noexcept {
  return activeCount() != 0;
}

std::uint32_t LiveKitLease::activeCount() noexcept {
  return active_livekit_leases.load(std::memory_order_acquire);
}

std::uint32_t LiveKitLease::initializeTransitionCount() noexcept {
  return livekit_initialize_transitions.load(std::memory_order_acquire);
}

std::uint32_t LiveKitLease::shutdownTransitionCount() noexcept {
  return livekit_shutdown_transitions.load(std::memory_order_acquire);
}

void LiveKitRuntimeLifetime::initialize() {
  std::lock_guard lock(mutex_);
  if (lease_) return;
  lease_.emplace();
  initialized_.store(true, std::memory_order_release);
}

RuntimeEvent reply(const MediaCommand& command) {
  RuntimeEvent event;
  event.type = NativeEventType::Reply;
  event.request_id = command.request_id;
  event.session_id = command.session_id;
  event.generation = command.generation;
  event.ok = true;
  return event;
}

RuntimeEvent failedReply(const MediaCommand& command, NativeError error) {
  auto event = reply(command);
  event.ok = false;
  event.error = std::move(error);
  return event;
}

RuntimeEvent lifecycle(
  const MediaCommand& command,
  const char* kind,
  const char* status,
  std::string detail
) {
  RuntimeEvent event;
  event.type = NativeEventType::SessionLifecycle;
  event.request_id = command.request_id;
  event.session_id = command.session_id;
  event.generation = command.generation;
  event.kind = kind;
  event.status = status;
  event.detail = std::move(detail);
  return event;
}

std::string warmKey(const MediaCommand& command) {
  return command.session_id.empty() ? "__pipeline__" : command.session_id;
}

}  // namespace syrnike::desktop_native::media
