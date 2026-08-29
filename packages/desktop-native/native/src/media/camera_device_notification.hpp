#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>

namespace syrnike::desktop_native::media {

enum class CameraDeviceNotificationAction {
  Arrival,
  Removal,
};

using CameraDeviceNotificationHandle = std::uintptr_t;
using CameraDeviceNotificationDispatch = void (*)(
    void*,
    CameraDeviceNotificationAction,
    std::wstring_view) noexcept;

// The adapter stores only this binding. Its context belongs to the deep
// CameraDeviceNotification module and remains heap-stable until unregister is
// confirmed or the process-lifetime quarantine retains it.
struct CameraDeviceNotificationCallback {
  void* context = nullptr;
  CameraDeviceNotificationDispatch dispatch = nullptr;
};

struct CameraDeviceNotificationNativeResult {
  bool succeeded = false;
  std::uint32_t code = 0;
};

class CameraDeviceNotificationAdapter {
 public:
  virtual ~CameraDeviceNotificationAdapter() = default;
  virtual CameraDeviceNotificationNativeResult registerNotification(
      CameraDeviceNotificationCallback* callback,
      CameraDeviceNotificationHandle& handle) noexcept = 0;
  // A successful unregister promises that the adapter will not begin another
  // callback. On failure it may keep using the supplied binding indefinitely.
  virtual CameraDeviceNotificationNativeResult unregisterNotification(
      CameraDeviceNotificationHandle handle) noexcept = 0;
};

enum class CameraDeviceNotificationStartStatus {
  Registered,
  RegistrationFailed,
  OwnershipUnavailable,
  AlreadyStarted,
};

struct CameraDeviceNotificationStartOutcome {
  CameraDeviceNotificationStartStatus status =
      CameraDeviceNotificationStartStatus::RegistrationFailed;
  std::uint32_t native_code = 0;
};

enum class CameraDeviceNotificationStopStatus {
  Unregistered,
  UnregisterFailedQuarantined,
  DrainTimedOutQuarantined,
  NotRegistered,
};

struct CameraDeviceNotificationStopOutcome {
  CameraDeviceNotificationStopStatus status =
      CameraDeviceNotificationStopStatus::NotRegistered;
  std::uint32_t native_code = 0;
  std::size_t unfinished_callbacks = 0;
};

struct CameraDeviceNotificationGlobalSnapshot {
  std::size_t ownership_capacity = 1;
  std::size_t owned_contexts = 0;
  std::size_t active_registrations = 0;
  std::size_t quarantined_contexts = 0;
  std::size_t accepting_contexts = 0;
  std::size_t in_flight_callbacks = 0;
  std::uint64_t registration_attempts = 0;
  std::uint64_t successful_registrations = 0;
  std::uint64_t failed_registrations = 0;
  std::uint64_t ownership_rejections = 0;
  std::uint64_t successful_unregistrations = 0;
  std::uint64_t failed_unregistrations = 0;
  std::uint64_t drain_timeouts = 0;
  std::uint64_t delivered_events = 0;
  std::uint64_t ignored_events = 0;
  std::uint32_t last_registration_code = 0;
  std::uint32_t last_unregistration_code = 0;
};

// Owns the process-wide camera notification slot. At most one active or
// quarantined callback context exists; an unconfirmed unregister permanently
// closes the slot so a later capture cannot replace memory Windows may retain.
class CameraDeviceNotification final {
 public:
  using Handler = std::function<void(CameraDeviceNotificationAction)>;
  using TimePoint = std::chrono::steady_clock::time_point;

  CameraDeviceNotification(
      std::shared_ptr<CameraDeviceNotificationAdapter> adapter,
      std::wstring device_id,
      Handler handler);
  ~CameraDeviceNotification();

  CameraDeviceNotification(const CameraDeviceNotification&) = delete;
  CameraDeviceNotification& operator=(const CameraDeviceNotification&) = delete;

  [[nodiscard]] CameraDeviceNotificationStartOutcome start();
  [[nodiscard]] CameraDeviceNotificationStopOutcome stop(
      TimePoint deadline) noexcept;

  [[nodiscard]] static CameraDeviceNotificationGlobalSnapshot
  globalSnapshot() noexcept;

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

[[nodiscard]] std::shared_ptr<CameraDeviceNotificationAdapter>
createWindowsCameraDeviceNotificationAdapter();

}  // namespace syrnike::desktop_native::media
