#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "media/camera_device_notification.hpp"

namespace {

using namespace std::chrono_literals;
using syrnike::desktop_native::media::CameraDeviceNotification;
using syrnike::desktop_native::media::CameraDeviceNotificationAction;
using syrnike::desktop_native::media::CameraDeviceNotificationAdapter;
using syrnike::desktop_native::media::CameraDeviceNotificationCallback;
using syrnike::desktop_native::media::CameraDeviceNotificationHandle;
using syrnike::desktop_native::media::CameraDeviceNotificationNativeResult;
using syrnike::desktop_native::media::CameraDeviceNotificationStartStatus;
using syrnike::desktop_native::media::CameraDeviceNotificationStopStatus;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

class FakeConfigManagerAdapter final
    : public CameraDeviceNotificationAdapter {
 public:
  CameraDeviceNotificationNativeResult registerNotification(
      CameraDeviceNotificationCallback* callback,
      CameraDeviceNotificationHandle& handle) noexcept override {
    std::lock_guard lock(mutex_);
    ++register_calls_;
    callback_ = register_result_.succeeded ? callback : nullptr;
    handle = register_result_.succeeded ? 1 : 0;
    return register_result_;
  }

  CameraDeviceNotificationNativeResult unregisterNotification(
      CameraDeviceNotificationHandle handle) noexcept override {
    std::lock_guard lock(mutex_);
    ++unregister_calls_;
    changed_.notify_all();
    if (handle != 1) return {false, 2};
    if (unregister_result_.succeeded) callback_ = nullptr;
    return unregister_result_;
  }

  void setUnregisterResult(
      CameraDeviceNotificationNativeResult result) noexcept {
    std::lock_guard lock(mutex_);
    unregister_result_ = result;
  }

  void setRegisterResult(
      CameraDeviceNotificationNativeResult result) noexcept {
    std::lock_guard lock(mutex_);
    register_result_ = result;
  }

  void fire(
      CameraDeviceNotificationAction action,
      std::wstring_view symbolic_link) {
    CameraDeviceNotificationCallback* callback = nullptr;
    {
      std::lock_guard lock(mutex_);
      callback = callback_;
    }
    if (callback) callback->dispatch(callback->context, action, symbolic_link);
  }

  [[nodiscard]] std::size_t registerCalls() const noexcept {
    std::lock_guard lock(mutex_);
    return register_calls_;
  }

  [[nodiscard]] std::size_t unregisterCalls() const noexcept {
    std::lock_guard lock(mutex_);
    return unregister_calls_;
  }

  [[nodiscard]] bool waitForUnregisterCalls(
      std::size_t expected,
      std::chrono::steady_clock::duration timeout) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(
        lock, timeout, [&] { return unregister_calls_ >= expected; });
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  CameraDeviceNotificationCallback* callback_ = nullptr;
  CameraDeviceNotificationNativeResult register_result_{true, 0};
  CameraDeviceNotificationNativeResult unregister_result_{true, 0};
  std::size_t register_calls_ = 0;
  std::size_t unregister_calls_ = 0;
};

void matchingEventsReachOnlyTheActiveRegistration() {
  auto adapter = std::make_shared<FakeConfigManagerAdapter>();
  std::vector<CameraDeviceNotificationAction> delivered;
  CameraDeviceNotification notification(
      adapter,
      L"camera-a",
      [&](CameraDeviceNotificationAction action) {
        delivered.push_back(action);
      });

  const auto started = notification.start();
  require(
      started.status == CameraDeviceNotificationStartStatus::Registered &&
          started.native_code == 0 && adapter->registerCalls() == 1,
      "camera device notification did not register");
  adapter->fire(
      CameraDeviceNotificationAction::Arrival,
      L"capture-device-camera-b");
  adapter->fire(
      CameraDeviceNotificationAction::Arrival,
      L"capture-device-camera-a");
  adapter->fire(
      CameraDeviceNotificationAction::Removal,
      L"capture-device-camera-a");
  require(
      delivered == std::vector<CameraDeviceNotificationAction>{
          CameraDeviceNotificationAction::Arrival,
          CameraDeviceNotificationAction::Removal},
      "camera notification did not filter events to its active device");

  const auto stopped = notification.stop(
      std::chrono::steady_clock::now() + 1s);
  require(
      stopped.status == CameraDeviceNotificationStopStatus::Unregistered &&
          stopped.native_code == 0 && adapter->unregisterCalls() == 1,
      "camera device notification did not unregister cleanly");
  const auto global = CameraDeviceNotification::globalSnapshot();
  require(
      global.owned_contexts == 0 && global.active_registrations == 0 &&
          global.quarantined_contexts == 0,
      "successful camera notification stop retained global ownership");
}

void registrationFailureReleasesTheProcessSlot() {
  auto adapter = std::make_shared<FakeConfigManagerAdapter>();
  adapter->setRegisterResult({false, 44});
  const auto baseline = CameraDeviceNotification::globalSnapshot();
  CameraDeviceNotification notification(
      adapter,
      L"camera-registration-failure",
      [](CameraDeviceNotificationAction) {});
  const auto started = notification.start();
  const auto failed = CameraDeviceNotification::globalSnapshot();
  require(
      started.status ==
              CameraDeviceNotificationStartStatus::RegistrationFailed &&
          started.native_code == 44 && failed.owned_contexts == 0 &&
          failed.failed_registrations - baseline.failed_registrations == 1 &&
          failed.last_registration_code == 44,
      "failed ConfigMgr registration retained or hid process ownership");

  auto replacement_adapter = std::make_shared<FakeConfigManagerAdapter>();
  CameraDeviceNotification replacement(
      replacement_adapter,
      L"camera-after-registration-failure",
      [](CameraDeviceNotificationAction) {});
  require(
      replacement.start().status ==
          CameraDeviceNotificationStartStatus::Registered,
      "failed ConfigMgr registration did not release the process slot");
  require(
      replacement.stop(std::chrono::steady_clock::now() + 1s).status ==
          CameraDeviceNotificationStopStatus::Unregistered,
      "replacement after registration failure did not stop");
}

void successfulStopDrainsCallbackAlreadyInFlight() {
  auto adapter = std::make_shared<FakeConfigManagerAdapter>();
  std::mutex mutex;
  std::condition_variable changed;
  bool callback_entered = false;
  bool release_callback = false;
  std::atomic_bool stop_finished{false};
  CameraDeviceNotification notification(
      adapter,
      L"camera-race",
      [&](CameraDeviceNotificationAction) {
        std::unique_lock lock(mutex);
        callback_entered = true;
        changed.notify_all();
        changed.wait(lock, [&] { return release_callback; });
      });
  require(
      notification.start().status ==
          CameraDeviceNotificationStartStatus::Registered,
      "callback race notification did not register");

  std::thread callback([&] {
    adapter->fire(
        CameraDeviceNotificationAction::Removal,
        L"capture-device-camera-race");
  });
  {
    std::unique_lock lock(mutex);
    require(
        changed.wait_for(lock, 1s, [&] { return callback_entered; }),
        "camera callback race did not enter its handler");
  }
  CameraDeviceNotificationStopStatus stop_status =
      CameraDeviceNotificationStopStatus::NotRegistered;
  std::thread stopper([&] {
    stop_status = notification.stop(
        std::chrono::steady_clock::now() + 1s).status;
    stop_finished.store(true, std::memory_order_release);
  });
  require(
      adapter->waitForUnregisterCalls(1, 1s),
      "concurrent stop did not reach ConfigMgr unregister");
  require(
      !stop_finished.load(std::memory_order_acquire),
      "successful unregister released an in-flight callback context");
  {
    std::lock_guard lock(mutex);
    release_callback = true;
  }
  changed.notify_all();
  callback.join();
  stopper.join();
  require(
      stop_status == CameraDeviceNotificationStopStatus::Unregistered &&
          stop_finished.load(std::memory_order_acquire),
      "successful unregister did not drain its in-flight callback");
}

void shutdownDeadlineRetainsThenReclaimsInFlightContext() {
  auto adapter = std::make_shared<FakeConfigManagerAdapter>();
  std::mutex mutex;
  std::condition_variable changed;
  bool callback_entered = false;
  bool release_callback = false;
  auto notification = std::make_unique<CameraDeviceNotification>(
      adapter,
      L"camera-deadline",
      [&](CameraDeviceNotificationAction) {
        std::unique_lock lock(mutex);
        callback_entered = true;
        changed.notify_all();
        changed.wait(lock, [&] { return release_callback; });
      });
  require(
      notification->start().status ==
          CameraDeviceNotificationStartStatus::Registered,
      "deadline notification did not register");
  std::thread callback([&] {
    adapter->fire(
        CameraDeviceNotificationAction::Removal,
        L"capture-device-camera-deadline");
  });
  {
    std::unique_lock lock(mutex);
    require(
        changed.wait_for(lock, 1s, [&] { return callback_entered; }),
        "deadline callback did not enter its handler");
  }

  const auto stop_started = std::chrono::steady_clock::now();
  const auto stopped = notification->stop(stop_started + 25ms);
  require(
      stopped.status ==
              CameraDeviceNotificationStopStatus::DrainTimedOutQuarantined &&
          stopped.unfinished_callbacks == 1 &&
          std::chrono::steady_clock::now() - stop_started < 250ms,
      "camera notification stop did not honor one shutdown deadline");
  auto retained = CameraDeviceNotification::globalSnapshot();
  require(
      retained.owned_contexts == 1 && retained.quarantined_contexts == 1 &&
          retained.in_flight_callbacks == 1 &&
          retained.accepting_contexts == 0,
      "deadline stop did not retain disabled callback ownership");
  notification.reset();
  {
    std::lock_guard lock(mutex);
    release_callback = true;
  }
  changed.notify_all();
  callback.join();
  retained = CameraDeviceNotification::globalSnapshot();
  require(
      retained.owned_contexts == 0 && retained.quarantined_contexts == 0,
      "confirmed unregister context was not reclaimed after callback drain");

  CameraDeviceNotification replacement(
      adapter, L"camera-replacement", [](CameraDeviceNotificationAction) {});
  require(
      replacement.start().status ==
          CameraDeviceNotificationStartStatus::Registered,
      "drained shutdown quarantine did not admit a replacement");
  require(
      replacement.stop(std::chrono::steady_clock::now() + 1s).status ==
          CameraDeviceNotificationStopStatus::Unregistered,
      "replacement camera notification did not stop");
}

void repeatedGenerationsKeepOneBoundedRegistration() {
  auto adapter = std::make_shared<FakeConfigManagerAdapter>();
  const auto baseline = CameraDeviceNotification::globalSnapshot();
  std::vector<std::size_t> delivered_generations;
  constexpr std::size_t generation_count = 64;
  for (std::size_t generation = 0; generation < generation_count;
       ++generation) {
    CameraDeviceNotification notification(
        adapter,
        L"camera-generation",
        [&, generation](CameraDeviceNotificationAction) {
          delivered_generations.push_back(generation);
        });
    require(
        notification.start().status ==
            CameraDeviceNotificationStartStatus::Registered,
        "repeated camera generation did not register");
    const auto active = CameraDeviceNotification::globalSnapshot();
    require(
        active.ownership_capacity == 1 && active.owned_contexts == 1 &&
            active.active_registrations == 1 &&
            active.quarantined_contexts == 0,
        "repeated camera generation exceeded bounded ownership");
    adapter->fire(
        CameraDeviceNotificationAction::Removal,
        L"capture-device-camera-generation");
    require(
        notification.stop(std::chrono::steady_clock::now() + 1s).status ==
            CameraDeviceNotificationStopStatus::Unregistered,
        "repeated camera generation did not unregister");
    const auto stopped = CameraDeviceNotification::globalSnapshot();
    require(
        stopped.owned_contexts == 0 && stopped.active_registrations == 0 &&
            stopped.quarantined_contexts == 0,
        "repeated camera generation retained notification ownership");
  }
  const auto final = CameraDeviceNotification::globalSnapshot();
  bool only_current_generation_was_delivered =
      delivered_generations.size() == generation_count;
  for (std::size_t generation = 0;
       only_current_generation_was_delivered && generation < generation_count;
       ++generation) {
    only_current_generation_was_delivered =
        delivered_generations[generation] == generation;
  }
  require(
      only_current_generation_was_delivered &&
          final.successful_registrations - baseline.successful_registrations ==
              generation_count &&
          final.successful_unregistrations -
                  baseline.successful_unregistrations ==
              generation_count,
      "repeated camera generations were not delivered and retired exactly once");
}

void utilityDestructorStopsAnActiveRegistration() {
  auto adapter = std::make_shared<FakeConfigManagerAdapter>();
  {
    CameraDeviceNotification notification(
        adapter,
        L"camera-utility-shutdown",
        [](CameraDeviceNotificationAction) {});
    require(
        notification.start().status ==
            CameraDeviceNotificationStartStatus::Registered,
        "utility shutdown notification did not register");
  }
  const auto global = CameraDeviceNotification::globalSnapshot();
  require(
      adapter->unregisterCalls() == 1 && global.owned_contexts == 0 &&
          global.quarantined_contexts == 0,
      "utility destructor did not unregister and release its callback context");
}

void unregisterFailureQuarantinesOneDisabledLateCallbackContext() {
  struct SimulatedCameraState {
    std::atomic_uint64_t callbacks{0};
  };

  auto adapter = std::make_shared<FakeConfigManagerAdapter>();
  const auto baseline = CameraDeviceNotification::globalSnapshot();
  std::atomic_uint64_t delivered{0};
  auto camera_state = std::make_unique<SimulatedCameraState>();
  auto* destroyed_camera_state = camera_state.get();
  adapter->setUnregisterResult({false, 55});
  {
    CameraDeviceNotification notification(
        adapter,
        L"camera-quarantine",
        [destroyed_camera_state, &delivered](CameraDeviceNotificationAction) {
          destroyed_camera_state->callbacks.fetch_add(
              1, std::memory_order_relaxed);
          delivered.fetch_add(1, std::memory_order_relaxed);
        });
    require(
        notification.start().status ==
            CameraDeviceNotificationStartStatus::Registered,
        "unregister failure notification did not register");
    const auto stopped = notification.stop(
        std::chrono::steady_clock::now() + 1s);
    require(
        stopped.status ==
                CameraDeviceNotificationStopStatus::
                    UnregisterFailedQuarantined &&
            stopped.native_code == 55,
        "failed ConfigMgr unregister was not surfaced explicitly");
  }

  camera_state.reset();
  adapter->fire(
      CameraDeviceNotificationAction::Removal,
      L"capture-device-camera-quarantine");
  require(
      delivered.load(std::memory_order_relaxed) == 0,
      "late callback reached destroyed camera notification state");
  const auto quarantined = CameraDeviceNotification::globalSnapshot();
  require(
      quarantined.ownership_capacity == 1 &&
          quarantined.owned_contexts == 1 &&
          quarantined.quarantined_contexts == 1 &&
          quarantined.accepting_contexts == 0 &&
          quarantined.failed_unregistrations -
                  baseline.failed_unregistrations ==
              1 &&
          quarantined.last_unregistration_code == 55,
      "unregister failure quarantine was not bounded and observable");

  auto replacement_adapter = std::make_shared<FakeConfigManagerAdapter>();
  CameraDeviceNotification replacement(
      replacement_adapter,
      L"camera-after-quarantine",
      [](CameraDeviceNotificationAction) {});
  require(
      replacement.start().status ==
              CameraDeviceNotificationStartStatus::OwnershipUnavailable &&
          replacement_adapter->registerCalls() == 0,
      "permanent quarantine admitted another ConfigMgr registration");
  const auto rejected = CameraDeviceNotification::globalSnapshot();
  require(
      rejected.owned_contexts == 1 && rejected.quarantined_contexts == 1 &&
          rejected.ownership_rejections - baseline.ownership_rejections == 1,
      "fail-closed registration was not counted without growing ownership");
}

}  // namespace

int main() try {
  matchingEventsReachOnlyTheActiveRegistration();
  registrationFailureReleasesTheProcessSlot();
  successfulStopDrainsCallbackAlreadyInFlight();
  shutdownDeadlineRetainsThenReclaimsInFlightContext();
  repeatedGenerationsKeepOneBoundedRegistration();
  utilityDestructorStopsAnActiveRegistration();
  unregisterFailureQuarantinesOneDisabledLateCallbackContext();
  return 0;
} catch (const std::exception& error) {
  std::fprintf(stderr, "%s\n", error.what());
  return 1;
}
