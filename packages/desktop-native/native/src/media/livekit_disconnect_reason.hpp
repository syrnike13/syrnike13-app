#pragma once

#include <cstdint>
#include <string>
#include <string_view>

#include <livekit/room_event_types.h>

namespace syrnike::desktop_native::media {

struct LiveKitDisconnectReasonInfo {
  std::string_view code;
  std::uint64_t numeric_code = 0;
  bool known = false;
};

inline constexpr std::string_view kLiveKitDisconnectedTerminalPrefix =
  "livekit_disconnected:";

inline LiveKitDisconnectReasonInfo describeLiveKitDisconnectReason(
  livekit::DisconnectReason reason
) noexcept {
  switch (reason) {
    case livekit::DisconnectReason::Unknown: return {"unknown", 0, true};
    case livekit::DisconnectReason::ClientInitiated: return {"client_initiated", 1, true};
    case livekit::DisconnectReason::DuplicateIdentity: return {"duplicate_identity", 2, true};
    case livekit::DisconnectReason::ServerShutdown: return {"server_shutdown", 3, true};
    case livekit::DisconnectReason::ParticipantRemoved: return {"participant_removed", 4, true};
    case livekit::DisconnectReason::RoomDeleted: return {"room_deleted", 5, true};
    case livekit::DisconnectReason::StateMismatch: return {"state_mismatch", 6, true};
    case livekit::DisconnectReason::JoinFailure: return {"join_failure", 7, true};
    case livekit::DisconnectReason::Migration: return {"migration", 8, true};
    case livekit::DisconnectReason::SignalClose: return {"signal_close", 9, true};
    case livekit::DisconnectReason::RoomClosed: return {"room_closed", 10, true};
    case livekit::DisconnectReason::UserUnavailable: return {"user_unavailable", 11, true};
    case livekit::DisconnectReason::UserRejected: return {"user_rejected", 12, true};
    case livekit::DisconnectReason::SipTrunkFailure: return {"sip_trunk_failure", 13, true};
    case livekit::DisconnectReason::ConnectionTimeout: return {"connection_timeout", 14, true};
    case livekit::DisconnectReason::MediaFailure: return {"media_failure", 15, true};
    default:
      return {"unknown", static_cast<std::uint64_t>(reason), false};
  }
}

inline std::string formatLiveKitDisconnectTerminalMessage(livekit::DisconnectReason reason) {
  const auto info = describeLiveKitDisconnectReason(reason);
  std::string message(kLiveKitDisconnectedTerminalPrefix);
  message.append(info.code);
  if (!info.known) {
    message.push_back(':');
    message.append(std::to_string(info.numeric_code));
  }
  return message;
}

inline bool isLiveKitDisconnectTerminalMessage(std::string_view message) noexcept {
  return message.starts_with(kLiveKitDisconnectedTerminalPrefix);
}

}  // namespace syrnike::desktop_native::media
