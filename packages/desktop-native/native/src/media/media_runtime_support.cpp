#include "media_runtime_support.hpp"

#include <livekit/livekit.h>

#include <cstdint>
#include <stdexcept>
#include <string_view>
#include <utility>

#include "../common/diagnostic_log.hpp"

namespace syrnike::desktop_native::media {
namespace {

void logLiveKitRuntime(std::string_view event) {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (logger.enabled()) logger.write(event);
}

}  // namespace

LiveKitLease::LiveKitLease() {
  logLiveKitRuntime("media_runtime_livekit_initialize_start");
  if (!livekit::initialize(livekit::LogLevel::Off)) {
    logLiveKitRuntime("media_runtime_livekit_initialize_failed");
    throw std::runtime_error("LiveKit initialization failed");
  }
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
}

LiveKitLease::~LiveKitLease() {
  logLiveKitRuntime("media_runtime_livekit_shutdown_start");
  if (diagnostics::DiagnosticLog::instance().enabled()) livekit::setLogCallback({});
  livekit::shutdown();
  logLiveKitRuntime("media_runtime_livekit_shutdown_done");
}

RuntimeEvent reply(const MediaCommand& command) {
  RuntimeEvent event;
  event.type = "reply";
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
  event.type = "sessionLifecycle";
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
