#pragma once

#include <string>

#include "../common/runtime_types.hpp"

namespace syrnike::desktop_native::media {

class LiveKitLease final {
 public:
  LiveKitLease();
  ~LiveKitLease();

  LiveKitLease(const LiveKitLease&) = delete;
  LiveKitLease& operator=(const LiveKitLease&) = delete;
};

RuntimeEvent reply(const MediaCommand& command);
RuntimeEvent failedReply(const MediaCommand& command, NativeError error);
RuntimeEvent lifecycle(
  const MediaCommand& command,
  const char* kind,
  const char* status,
  std::string detail = {}
);
std::string warmKey(const MediaCommand& command);

}  // namespace syrnike::desktop_native::media
