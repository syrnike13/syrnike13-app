#include "camera_device_notification.hpp"

#include <windows.h>
#include <cfgmgr32.h>
#include <ks.h>

#include <condition_variable>
#include <cwctype>
#include <mutex>
#include <utility>

namespace syrnike::desktop_native::media {
namespace {

constexpr auto kDestructorDrainBudget = std::chrono::milliseconds(250);

std::wstring lowercase(std::wstring value) {
  for (auto& character : value) {
    character = static_cast<wchar_t>(std::towlower(character));
  }
  return value;
}

bool containsCaseInsensitive(
    std::wstring_view haystack,
    std::wstring_view needle) noexcept {
  if (needle.empty() || needle.size() > haystack.size()) return false;
  for (std::size_t offset = 0;
       offset + needle.size() <= haystack.size(); ++offset) {
    bool equal = true;
    for (std::size_t index = 0; index < needle.size(); ++index) {
      if (std::towlower(haystack[offset + index]) !=
          std::towlower(needle[index])) {
        equal = false;
        break;
      }
    }
    if (equal) return true;
  }
  return false;
}

class CallbackContext final {
 public:
  CallbackContext(std::wstring device_id, CameraDeviceNotification::Handler handler)
      : device_id_(lowercase(std::move(device_id))),
        handler_(std::move(handler)) {
    callback_.context = this;
    callback_.dispatch = &dispatch;
  }

  [[nodiscard]] CameraDeviceNotificationCallback* callback() noexcept {
    return &callback_;
  }

  void disable() noexcept {
    std::lock_guard lock(mutex_);
    accepting_ = false;
    handler_ = {};
  }

  [[nodiscard]] bool waitUntil(
      CameraDeviceNotification::TimePoint deadline) noexcept {
    std::unique_lock lock(mutex_);
    drained_.wait_until(lock, deadline, [&] { return in_flight_ == 0; });
    return in_flight_ == 0;
  }

  [[nodiscard]] bool drained() const noexcept {
    std::lock_guard lock(mutex_);
    return in_flight_ == 0;
  }

  [[nodiscard]] bool accepting() const noexcept {
    std::lock_guard lock(mutex_);
    return accepting_;
  }

  [[nodiscard]] std::size_t inFlight() const noexcept {
    std::lock_guard lock(mutex_);
    return in_flight_;
  }

  [[nodiscard]] std::uint64_t delivered() const noexcept {
    std::lock_guard lock(mutex_);
    return delivered_;
  }

  [[nodiscard]] std::uint64_t ignored() const noexcept {
    std::lock_guard lock(mutex_);
    return ignored_;
  }

 private:
  static void dispatch(
      void* context,
      CameraDeviceNotificationAction action,
      std::wstring_view symbolic_link) noexcept {
    if (!context) return;
    static_cast<CallbackContext*>(context)->invoke(action, symbolic_link);
  }

  void invoke(
      CameraDeviceNotificationAction action,
      std::wstring_view symbolic_link) noexcept {
    CameraDeviceNotification::Handler handler;
    {
      std::lock_guard lock(mutex_);
      ++in_flight_;
      const bool matches = !device_id_.empty() && !symbolic_link.empty() &&
          (containsCaseInsensitive(symbolic_link, device_id_) ||
           containsCaseInsensitive(device_id_, symbolic_link));
      if (!accepting_ || !matches || !handler_) {
        ++ignored_;
      } else {
        try {
          handler = handler_;
        } catch (...) {
          ++ignored_;
        }
      }
    }

    if (handler) {
      try {
        handler(action);
      } catch (...) {
      }
    }

    {
      std::lock_guard lock(mutex_);
      if (handler) ++delivered_;
      --in_flight_;
      if (in_flight_ == 0) drained_.notify_all();
    }
  }

  CameraDeviceNotificationCallback callback_;
  mutable std::mutex mutex_;
  std::condition_variable drained_;
  std::wstring device_id_;
  CameraDeviceNotification::Handler handler_;
  std::size_t in_flight_ = 0;
  std::uint64_t delivered_ = 0;
  std::uint64_t ignored_ = 0;
  bool accepting_ = true;
};

enum class GlobalOwnershipMode {
  Empty,
  Registering,
  Active,
  DrainingQuarantine,
  PermanentQuarantine,
};

struct GlobalState {
  std::mutex mutex;
  std::shared_ptr<CallbackContext> context;
  GlobalOwnershipMode mode = GlobalOwnershipMode::Empty;
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

GlobalState& globalState() {
  // Windows may retain the callback address after a failed unregister, so the
  // bounded quarantine and its owner deliberately outlive static teardown.
  static auto* state = new GlobalState();
  return *state;
}

void recordAndReleaseContextLocked(GlobalState& global) noexcept {
  if (!global.context) return;
  global.delivered_events += global.context->delivered();
  global.ignored_events += global.context->ignored();
  global.context.reset();
  global.mode = GlobalOwnershipMode::Empty;
}

void reclaimDrainedContextLocked(GlobalState& global) noexcept {
  if (global.mode == GlobalOwnershipMode::DrainingQuarantine &&
      global.context && global.context->drained()) {
    recordAndReleaseContextLocked(global);
  }
}

class WindowsCameraDeviceNotificationAdapter final
    : public CameraDeviceNotificationAdapter {
 public:
  CameraDeviceNotificationNativeResult registerNotification(
      CameraDeviceNotificationCallback* callback,
      CameraDeviceNotificationHandle& handle) noexcept override {
    CM_NOTIFY_FILTER filter{};
    filter.cbSize = sizeof(filter);
    filter.FilterType = CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE;
    filter.u.DeviceInterface.ClassGuid = KSCATEGORY_VIDEO_CAMERA;
    HCMNOTIFICATION notification = nullptr;
    const auto result = CM_Register_Notification(
        &filter, callback, &onNotification, &notification);
    handle = result == CR_SUCCESS
        ? reinterpret_cast<CameraDeviceNotificationHandle>(notification)
        : 0;
    return {
        result == CR_SUCCESS,
        static_cast<std::uint32_t>(result),
    };
  }

  CameraDeviceNotificationNativeResult unregisterNotification(
      CameraDeviceNotificationHandle handle) noexcept override {
    const auto result = CM_Unregister_Notification(
        reinterpret_cast<HCMNOTIFICATION>(handle));
    return {
        result == CR_SUCCESS,
        static_cast<std::uint32_t>(result),
    };
  }

 private:
  static DWORD CALLBACK onNotification(
      HCMNOTIFICATION,
      PVOID context,
      CM_NOTIFY_ACTION action,
      PCM_NOTIFY_EVENT_DATA event,
      DWORD) noexcept {
    try {
      if (!context || !event ||
          event->FilterType != CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE ||
          !event->u.DeviceInterface.SymbolicLink) {
        return ERROR_SUCCESS;
      }
      CameraDeviceNotificationAction translated;
      if (action == CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL) {
        translated = CameraDeviceNotificationAction::Arrival;
      } else if (action == CM_NOTIFY_ACTION_DEVICEINTERFACEREMOVAL) {
        translated = CameraDeviceNotificationAction::Removal;
      } else {
        return ERROR_SUCCESS;
      }
      auto* callback = static_cast<CameraDeviceNotificationCallback*>(context);
      if (callback->dispatch) {
        callback->dispatch(
            callback->context,
            translated,
            event->u.DeviceInterface.SymbolicLink);
      }
    } catch (...) {
      // Never unwind through Configuration Manager.
    }
    return ERROR_SUCCESS;
  }
};

}  // namespace

class CameraDeviceNotification::Implementation final {
 public:
  Implementation(
      std::shared_ptr<CameraDeviceNotificationAdapter> adapter,
      std::wstring device_id,
      Handler handler)
      : adapter_(std::move(adapter)),
        device_id_(std::move(device_id)),
        handler_(std::move(handler)) {}

  ~Implementation() {
    static_cast<void>(stop(
        std::chrono::steady_clock::now() + kDestructorDrainBudget));
  }

  CameraDeviceNotificationStartOutcome start() {
    std::lock_guard lifecycle_lock(lifecycle_mutex_);
    if (phase_ != Phase::New) {
      return {CameraDeviceNotificationStartStatus::AlreadyStarted, 0};
    }
    if (!adapter_) {
      phase_ = Phase::Stopped;
      return {CameraDeviceNotificationStartStatus::RegistrationFailed, 0};
    }

    context_ = std::make_shared<CallbackContext>(
        device_id_, std::move(handler_));
    auto& global = globalState();
    {
      std::lock_guard lock(global.mutex);
      reclaimDrainedContextLocked(global);
      ++global.registration_attempts;
      if (global.context) {
        ++global.ownership_rejections;
        phase_ = Phase::Stopped;
        context_->disable();
        return {
            CameraDeviceNotificationStartStatus::OwnershipUnavailable,
            0,
        };
      }
      global.context = context_;
      global.mode = GlobalOwnershipMode::Registering;
    }

    CameraDeviceNotificationHandle handle = 0;
    const auto native = adapter_->registerNotification(
        context_->callback(), handle);
    {
      std::lock_guard lock(global.mutex);
      global.last_registration_code = native.code;
      if (!native.succeeded || handle == 0) {
        ++global.failed_registrations;
        context_->disable();
        recordAndReleaseContextLocked(global);
        phase_ = Phase::Stopped;
        return {
            CameraDeviceNotificationStartStatus::RegistrationFailed,
            native.code,
        };
      }
      ++global.successful_registrations;
      global.mode = GlobalOwnershipMode::Active;
    }
    handle_ = handle;
    phase_ = Phase::Registered;
    return {CameraDeviceNotificationStartStatus::Registered, native.code};
  }

  CameraDeviceNotificationStopOutcome stop(TimePoint deadline) noexcept {
    std::lock_guard lifecycle_lock(lifecycle_mutex_);
    if (phase_ != Phase::Registered || !context_) {
      return {CameraDeviceNotificationStopStatus::NotRegistered, 0, 0};
    }
    context_->disable();
    const auto native = adapter_->unregisterNotification(handle_);
    auto& global = globalState();
    {
      std::lock_guard lock(global.mutex);
      global.last_unregistration_code = native.code;
      if (!native.succeeded) {
        ++global.failed_unregistrations;
        global.mode = GlobalOwnershipMode::PermanentQuarantine;
      } else {
        ++global.successful_unregistrations;
      }
    }

    const bool drained = context_->waitUntil(deadline);
    const auto unfinished = context_->inFlight();
    {
      std::lock_guard lock(global.mutex);
      if (!native.succeeded) {
        if (!drained) ++global.drain_timeouts;
      } else if (drained) {
        recordAndReleaseContextLocked(global);
      } else {
        ++global.drain_timeouts;
        global.mode = GlobalOwnershipMode::DrainingQuarantine;
      }
    }
    phase_ = Phase::Stopped;
    if (!native.succeeded) {
      return {
          CameraDeviceNotificationStopStatus::UnregisterFailedQuarantined,
          native.code,
          unfinished,
      };
    }
    return {
        drained
            ? CameraDeviceNotificationStopStatus::Unregistered
            : CameraDeviceNotificationStopStatus::DrainTimedOutQuarantined,
        native.code,
        unfinished,
    };
  }

 private:
  enum class Phase {
    New,
    Registered,
    Stopped,
  };

  std::mutex lifecycle_mutex_;
  std::shared_ptr<CameraDeviceNotificationAdapter> adapter_;
  std::wstring device_id_;
  Handler handler_;
  std::shared_ptr<CallbackContext> context_;
  CameraDeviceNotificationHandle handle_ = 0;
  Phase phase_ = Phase::New;
};

CameraDeviceNotification::CameraDeviceNotification(
    std::shared_ptr<CameraDeviceNotificationAdapter> adapter,
    std::wstring device_id,
    Handler handler)
    : implementation_(std::make_unique<Implementation>(
          std::move(adapter), std::move(device_id), std::move(handler))) {}

CameraDeviceNotification::~CameraDeviceNotification() = default;

CameraDeviceNotificationStartOutcome CameraDeviceNotification::start() {
  return implementation_->start();
}

CameraDeviceNotificationStopOutcome CameraDeviceNotification::stop(
    TimePoint deadline) noexcept {
  return implementation_->stop(deadline);
}

CameraDeviceNotificationGlobalSnapshot
CameraDeviceNotification::globalSnapshot() noexcept {
  auto& global = globalState();
  std::lock_guard lock(global.mutex);
  reclaimDrainedContextLocked(global);
  CameraDeviceNotificationGlobalSnapshot result;
  result.registration_attempts = global.registration_attempts;
  result.successful_registrations = global.successful_registrations;
  result.failed_registrations = global.failed_registrations;
  result.ownership_rejections = global.ownership_rejections;
  result.successful_unregistrations = global.successful_unregistrations;
  result.failed_unregistrations = global.failed_unregistrations;
  result.drain_timeouts = global.drain_timeouts;
  result.delivered_events = global.delivered_events;
  result.ignored_events = global.ignored_events;
  result.last_registration_code = global.last_registration_code;
  result.last_unregistration_code = global.last_unregistration_code;
  if (global.context) {
    result.owned_contexts = 1;
    result.active_registrations =
        global.mode == GlobalOwnershipMode::Active ? 1 : 0;
    result.quarantined_contexts =
        global.mode == GlobalOwnershipMode::DrainingQuarantine ||
            global.mode == GlobalOwnershipMode::PermanentQuarantine
        ? 1
        : 0;
    result.accepting_contexts = global.context->accepting() ? 1 : 0;
    result.in_flight_callbacks = global.context->inFlight();
    result.delivered_events += global.context->delivered();
    result.ignored_events += global.context->ignored();
  }
  return result;
}

std::shared_ptr<CameraDeviceNotificationAdapter>
createWindowsCameraDeviceNotificationAdapter() {
  static auto adapter =
      std::make_shared<WindowsCameraDeviceNotificationAdapter>();
  return adapter;
}

}  // namespace syrnike::desktop_native::media
