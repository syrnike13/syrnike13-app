#include "sources/win32_source_enumerator.hpp"
#include "sources/utf8.hpp"

#include <windows.h>
#include <dwmapi.h>
#include <shellscalingapi.h>

#include <algorithm>
#include <atomic>
#include <charconv>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iomanip>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace syrnike::windows_media::sources {
namespace {

inline constexpr std::size_t kMaximumProcessPathCharacters = 32768;

struct HandleCloser {
  void operator()(void* handle) const noexcept {
    if (handle != nullptr && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  }
};
using UniqueHandle = std::unique_ptr<void, HandleCloser>;

std::string utf8(const wchar_t* value, std::size_t length) {
  if (length == 0) return {};
  const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value,
                                            static_cast<int>(length), nullptr, 0,
                                            nullptr, nullptr);
  if (required <= 0) return {};
  std::string output(static_cast<std::size_t>(required), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value,
                      static_cast<int>(length), output.data(), required, nullptr,
                      nullptr);
  return output;
}

std::string utf8(const std::wstring& value) {
  return utf8(value.data(), value.size());
}

std::wstring windowText(HWND window) {
  wchar_t text[kMaximumSourceTextBytes + 1]{};
  const int copied = GetWindowTextW(
      window, text, static_cast<int>(std::size(text)));
  if (copied <= 0) return {};
  return std::wstring(text, static_cast<std::size_t>(copied));
}

std::string applicationLabel(DWORD process_id) {
  UniqueHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                   process_id));
  if (!process) return {};
  std::wstring value(kMaximumProcessPathCharacters, L'\0');
  DWORD length = static_cast<DWORD>(value.size());
  if (!QueryFullProcessImageNameW(process.get(), 0, value.data(), &length)) {
    return {};
  }
  value.resize(length);
  const auto separator = value.find_last_of(L"\\/");
  const auto label = separator == std::wstring::npos
                         ? value
                         : value.substr(separator + 1);
  return sanitizeBoundedUtf8(utf8(label), kMaximumSourceTextBytes);
}

std::uint64_t processCreation(DWORD process_id) {
  UniqueHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                   process_id));
  if (!process) return 0;
  FILETIME creation{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(process.get(), &creation, &exit, &kernel, &user)) return 0;
  return (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32U) |
         creation.dwLowDateTime;
}

std::string hexValue(std::uint64_t value) {
  std::ostringstream output;
  output << std::hex << value;
  return output.str();
}

std::string windowFingerprint(HWND window) {
  if (!IsWindow(window) || GetAncestor(window, GA_ROOT) != window) return {};
  DWORD process_id = 0;
  const DWORD thread_id = GetWindowThreadProcessId(window, &process_id);
  if (process_id == 0 || thread_id == 0) return {};
  wchar_t class_name[256]{};
  const int class_length = GetClassNameW(
      window, class_name, static_cast<int>(std::size(class_name)));
  return "window:" +
         hexValue(reinterpret_cast<std::uintptr_t>(window)) + ":" +
         std::to_string(process_id) + ":" +
         std::to_string(processCreation(process_id)) + ":" +
         std::to_string(thread_id) + ":" +
         utf8(class_name, class_length > 0
                              ? static_cast<std::size_t>(class_length)
                              : 0);
}

std::optional<HWND> windowHandleFromIdentity(const std::string& identity) {
  constexpr std::string_view prefix = "window:";
  if (!identity.starts_with(prefix)) return std::nullopt;
  const auto separator = identity.find(':', prefix.size());
  if (separator == std::string::npos || separator == prefix.size()) {
    return std::nullopt;
  }
  std::uintptr_t value = 0;
  const auto* begin = identity.data() + prefix.size();
  const auto* end = identity.data() + separator;
  const auto parsed = std::from_chars(begin, end, value, 16);
  if (parsed.ec != std::errc{} || parsed.ptr != end || value == 0) {
    return std::nullopt;
  }
  return reinterpret_cast<HWND>(value);
}

struct DisplayIdentity {
  std::wstring gdi_name;
  std::string identity;
  std::string label;
};

struct DisplayIdentityResult {
  std::vector<DisplayIdentity> identities;
  std::string failure;
};

bool sameDisplayMapping(const std::vector<DisplayIdentity>& left,
                        const std::vector<DisplayIdentity>& right) {
  if (left.size() != right.size()) return false;
  return std::all_of(left.begin(), left.end(), [&](const DisplayIdentity& value) {
    return std::any_of(right.begin(), right.end(),
                       [&](const DisplayIdentity& candidate) {
                         return _wcsicmp(value.gdi_name.c_str(),
                                         candidate.gdi_name.c_str()) == 0 &&
                                value.identity == candidate.identity;
                       });
  });
}

struct WindowEventState {
  explicit WindowEventState(std::size_t maximum) : capacity(maximum) {}
  std::mutex mutex;
  std::unordered_map<HWND, std::uint64_t> epochs;
  std::uint64_t next_epoch = 0;
  const std::size_t capacity;
  std::atomic<bool> stopping{false};
};

std::mutex tracker_map_mutex;
std::unordered_map<HWINEVENTHOOK, std::weak_ptr<WindowEventState>> trackers;

class WindowLifetimeTracker final {
 public:
  static constexpr UINT kFlushMessage = WM_APP + 0x321;

  explicit WindowLifetimeTracker(std::size_t capacity)
      : event_state_(std::make_shared<WindowEventState>(capacity)) {
    if (capacity == 0 || capacity > kMaximumTrackedWindows) {
      throw std::invalid_argument("invalid WinEvent tracker capacity");
    }
    stop_event_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!stop_event_) throw std::runtime_error("WinEvent stop event creation failed");
    thread_ = std::thread([this] { run(); });
    std::unique_lock lock(mutex_);
    if (!ready_.wait_for(lock, std::chrono::seconds(2),
                         [this] { return ready_flag_; })) {
      lock.unlock();
      SetEvent(stop_event_.get());
      thread_.join();
      throw std::runtime_error("WinEvent thread startup deadline exceeded");
    }
  }

  ~WindowLifetimeTracker() noexcept {
    requestStop();
    if (thread_.joinable()) thread_.join();
  }

  std::optional<std::string> suffix(HWND window) {
    std::lock_guard lock(event_state_->mutex);
    if (event_state_->stopping.load()) return std::nullopt;
    auto found = event_state_->epochs.find(window);
    if (found == event_state_->epochs.end()) {
      if (event_state_->epochs.size() >= event_state_->capacity) {
        for (auto iterator = event_state_->epochs.begin();
             iterator != event_state_->epochs.end();) {
          if (!IsWindow(iterator->first))
            iterator = event_state_->epochs.erase(iterator);
          else
            ++iterator;
        }
      }
      if (event_state_->epochs.size() >= event_state_->capacity)
        return std::nullopt;
      found = event_state_->epochs
                  .emplace(window, ++event_state_->next_epoch)
                  .first;
    }
    return ":event:" + std::to_string(found->second);
  }

  void reconcile(const std::vector<HWND>& live) {
    std::lock_guard lock(event_state_->mutex);
    for (auto iterator = event_state_->epochs.begin();
         iterator != event_state_->epochs.end();) {
      if (std::find(live.begin(), live.end(), iterator->first) == live.end())
        iterator = event_state_->epochs.erase(iterator);
      else
        ++iterator;
    }
  }

  void pruneDead() {
    std::lock_guard lock(event_state_->mutex);
    for (auto iterator = event_state_->epochs.begin();
         iterator != event_state_->epochs.end();) {
      if (!IsWindow(iterator->first))
        iterator = event_state_->epochs.erase(iterator);
      else
        ++iterator;
    }
  }

  bool flush() {
    std::unique_lock lock(mutex_);
    if (thread_id_ == 0 || event_state_->stopping.load()) return false;
    const auto sequence = ++flush_requested_;
    if (!PostThreadMessageW(thread_id_, kFlushMessage,
                            static_cast<WPARAM>(sequence), 0)) {
      return false;
    }
    return flush_completed_.wait_for(
        lock, std::chrono::seconds(1), [this, sequence] {
          return event_state_->stopping.load() ||
                 flush_completed_sequence_ >= sequence;
        }) && !event_state_->stopping.load();
  }

  bool available() const {
    std::lock_guard lock(mutex_);
    return hook_available_ && !event_state_->stopping.load();
  }

  void requestStop() noexcept {
    event_state_->stopping.store(true);
    if (stop_event_) SetEvent(stop_event_.get());
    flush_completed_.notify_all();
    ready_.notify_all();
  }

 private:
  static void CALLBACK eventCallback(HWINEVENTHOOK hook, DWORD, HWND window,
                                     LONG object_id, LONG child_id, DWORD,
                                     DWORD) {
    if (window == nullptr || object_id != OBJID_WINDOW ||
        child_id != CHILDID_SELF) {
      return;
    }
    std::shared_ptr<WindowEventState> state;
    {
      std::lock_guard lock(tracker_map_mutex);
      const auto found = trackers.find(hook);
      if (found != trackers.end()) state = found->second.lock();
    }
    if (!state) return;
    std::lock_guard lock(state->mutex);
    if (state->stopping.load()) return;
    const auto found = state->epochs.find(window);
    if (found != state->epochs.end())
      found->second = ++state->next_epoch;
  }

  void run() {
    MSG message{};
    PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    const DWORD thread_id = GetCurrentThreadId();
    const HWINEVENTHOOK hook = SetWinEventHook(
        EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, nullptr, &eventCallback, 0, 0,
        WINEVENT_OUTOFCONTEXT);
    if (hook != nullptr) {
      std::lock_guard lock(tracker_map_mutex);
      trackers.emplace(hook, event_state_);
    }
    {
      std::lock_guard lock(mutex_);
      thread_id_ = thread_id;
      hook_available_ = hook != nullptr;
      ready_flag_ = true;
    }
    ready_.notify_all();
    HANDLE stop = stop_event_.get();
    bool stopping = false;
    while (!stopping) {
      const DWORD wait = MsgWaitForMultipleObjects(
          1, &stop, FALSE, INFINITE, QS_ALLINPUT);
      if (wait == WAIT_OBJECT_0) break;
      if (wait != WAIT_OBJECT_0 + 1) break;
      while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        if (message.message == kFlushMessage) {
          {
            std::lock_guard lock(mutex_);
            flush_completed_sequence_ = std::max(
                flush_completed_sequence_,
                static_cast<std::uint64_t>(message.wParam));
          }
          flush_completed_.notify_all();
          continue;
        }
        if (message.message == WM_QUIT) {
          stopping = true;
          break;
        }
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
    }
    if (hook != nullptr) {
      {
        std::lock_guard lock(tracker_map_mutex);
        trackers.erase(hook);
      }
      UnhookWinEvent(hook);
    }
  }

  mutable std::mutex mutex_;
  std::condition_variable ready_;
  std::condition_variable flush_completed_;
  std::shared_ptr<WindowEventState> event_state_;
  UniqueHandle stop_event_;
  DWORD thread_id_ = 0;
  std::uint64_t flush_requested_ = 0;
  std::uint64_t flush_completed_sequence_ = 0;
  bool ready_flag_ = false;
  bool hook_available_ = false;
  std::thread thread_;
};

DisplayIdentityResult displayIdentities() {
  std::vector<DISPLAYCONFIG_PATH_INFO> paths;
  bool queried = false;
  for (int attempt = 0; attempt < 3; ++attempt) {
    UINT32 path_count = 0;
    UINT32 mode_count = 0;
    const LONG sizing = GetDisplayConfigBufferSizes(
        QDC_ONLY_ACTIVE_PATHS, &path_count, &mode_count);
    if (sizing != ERROR_SUCCESS) {
      return {{}, "display_config_sizing_failed"};
    }
    if (path_count > 64 || mode_count > 256) {
      return {{}, "display_config_capacity_exceeded"};
    }
    paths.assign(path_count, {});
    std::vector<DISPLAYCONFIG_MODE_INFO> modes(mode_count);
    const LONG query = QueryDisplayConfig(
        QDC_ONLY_ACTIVE_PATHS, &path_count, paths.data(), &mode_count,
        modes.data(), nullptr);
    if (query == ERROR_INSUFFICIENT_BUFFER) continue;
    if (query != ERROR_SUCCESS) return {{}, "display_config_query_failed"};
    paths.resize(path_count);
    queried = true;
    break;
  }
  if (!queried) return {{}, "display_config_topology_race"};
  DisplayIdentityResult result;
  for (const auto& path : paths) {
    DISPLAYCONFIG_SOURCE_DEVICE_NAME source{};
    source.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
    source.header.size = sizeof(source);
    source.header.adapterId = path.sourceInfo.adapterId;
    source.header.id = path.sourceInfo.id;
    if (DisplayConfigGetDeviceInfo(&source.header) != ERROR_SUCCESS) {
      return {{}, "display_config_source_identity_failed"};
    }

    DISPLAYCONFIG_TARGET_DEVICE_NAME target{};
    target.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
    target.header.size = sizeof(target);
    target.header.adapterId = path.targetInfo.adapterId;
    target.header.id = path.targetInfo.id;
    const auto target_result = DisplayConfigGetDeviceInfo(&target.header);
    std::string label;
    if (target_result == ERROR_SUCCESS) {
      label = utf8(target.monitorFriendlyDeviceName,
          std::char_traits<wchar_t>::length(target.monitorFriendlyDeviceName));
    }
    // Use one namespace for the full adapter lifetime. monitorDevicePath is
    // optional and can appear/disappear across successful topology queries;
    // switching between it and the target tuple would rotate a live source ID.
    const auto luid = (static_cast<std::uint64_t>(static_cast<std::uint32_t>(
                           path.targetInfo.adapterId.HighPart))
                       << 32U) |
                      path.targetInfo.adapterId.LowPart;
    std::string identity = "monitor-target:" + hexValue(luid) + ":" +
                           std::to_string(path.targetInfo.id);
    result.identities.push_back({source.viewGdiDeviceName, std::move(identity),
                                 std::move(label)});
  }
  return result;
}

class Win32SourceEnumerator final : public SourceEnumerator {
 public:
  explicit Win32SourceEnumerator(Win32SourceEnumeratorTestHooks test_hooks)
      : test_hooks_(std::move(test_hooks)),
        lifetime_tracker_(test_hooks_.maximum_tracked_windows) {}

  void requestStop() noexcept override {
    cancelled_.store(true);
    lifetime_tracker_.requestStop();
    if (test_hooks_.on_cancel) test_hooks_.on_cancel();
  }

  EnumerationBatch enumerate(const EnumerationOptions& options) override {
    EnumerationBatch batch;
    if (cancelled_.load()) {
      markCancelled(batch, options);
      return batch;
    }
    if (options.kind != EnumerationOptions::Kind::Window) enumerateMonitors(batch);
    if (cancelled_.load()) return batch;
    if (options.kind != EnumerationOptions::Kind::Monitor) {
      if (!lifetime_tracker_.available()) {
        batch.windows = EnumerationCompleteness::Failed;
        batch.diagnostics.push_back(
            {"window_lifetime_events_unavailable",
             "WinEvent hook could not be installed; no window IDs were issued"});
        return batch;
      }
      if (!lifetime_tracker_.flush()) {
        batch.windows = EnumerationCompleteness::Failed;
        batch.diagnostics.push_back(
            {"window_lifetime_tracker_unresponsive",
             "pre-enumeration WinEvent barrier missed its deadline"});
        return batch;
      }
      lifetime_tracker_.pruneDead();
      WindowContext context{this, &batch, options.include_own_windows};
      const BOOL enumerated =
          EnumWindows(&enumerateWindow, reinterpret_cast<LPARAM>(&context));
      if (context.cancelled || cancelled_.load()) {
        eraseWindows(batch);
        markCancelled(batch, options);
        return batch;
      }
      if ((!enumerated && !context.intentional_stop) || context.identity_failed) {
        batch.windows = EnumerationCompleteness::Failed;
        batch.diagnostics.push_back(
            {context.identity_failed ? "window_lifetime_capacity_exceeded"
                                     : "enum_windows_failed",
             "window snapshot was discarded before identity reconciliation"});
        eraseWindows(batch);
        return batch;
      }
      if (test_hooks_.force_windows_truncated)
        batch.windows_truncated = true;
      if (test_hooks_.before_post_barrier) test_hooks_.before_post_barrier();
      if (cancelled_.load()) {
        eraseWindows(batch);
        markCancelled(batch, options);
        return batch;
      }
      if (!lifetime_tracker_.flush()) {
        if (cancelled_.load()) {
          eraseWindows(batch);
          markCancelled(batch, options);
          return batch;
        }
        batch.windows = EnumerationCompleteness::Failed;
        batch.diagnostics.push_back(
            {"window_lifetime_tracker_unresponsive",
             "post-enumeration WinEvent barrier missed its deadline"});
        eraseWindows(batch);
        return batch;
      }
      const auto validate_observed = [&] {
        for (const auto& observed : context.observed) {
          const bool fingerprint_valid =
              windowFingerprint(observed.window) == observed.fingerprint;
          const auto suffix = fingerprint_valid
                                  ? lifetime_tracker_.suffix(observed.window)
                                  : std::nullopt;
          const bool valid = suffix && observed.identity.ends_with(*suffix);
          if (valid) continue;
          batch.candidates.erase(
              std::remove_if(batch.candidates.begin(), batch.candidates.end(),
                             [&](const SourceCandidate& candidate) {
                               return candidate.kind == SourceKind::Window &&
                                      candidate.identity == observed.identity;
                             }),
              batch.candidates.end());
          appendOmission(batch, "window_closed_during_enumeration",
                         "candidate changed across the final lifetime barrier");
        }
      };
      validate_observed();
      if (test_hooks_.before_final_barrier) test_hooks_.before_final_barrier();
      if (cancelled_.load() || !lifetime_tracker_.flush()) {
        if (cancelled_.load()) {
          eraseWindows(batch);
          markCancelled(batch, options);
        } else {
          batch.windows = EnumerationCompleteness::Failed;
          appendOmission(batch, "window_lifetime_tracker_unresponsive",
                         "final WinEvent barrier missed its deadline");
          eraseWindows(batch);
        }
        return batch;
      }
      validate_observed();
      std::stable_sort(
          batch.candidates.begin(), batch.candidates.end(),
          [](const SourceCandidate& left, const SourceCandidate& right) {
            if (left.kind != right.kind) return left.kind == SourceKind::Monitor;
            if (left.kind != SourceKind::Window) return false;
            const bool left_selectable = left.flags.visible && left.exclusions.empty();
            const bool right_selectable = right.flags.visible && right.exclusions.empty();
            return left_selectable && !right_selectable;
          });
      std::size_t kept_windows = 0;
      batch.candidates.erase(
          std::remove_if(batch.candidates.begin(), batch.candidates.end(),
                         [&](const SourceCandidate& candidate) {
                           if (candidate.kind != SourceKind::Window) return false;
                           ++kept_windows;
                           if (kept_windows > kMaximumWindows)
                             batch.windows_truncated = true;
                           return kept_windows > kMaximumWindows + 1;
                         }),
          batch.candidates.end());
      std::unordered_set<std::string> retained_identities;
      for (const auto& candidate : batch.candidates) {
        if (candidate.kind == SourceKind::Window)
          retained_identities.insert(candidate.identity);
      }
      std::vector<HWND> retained_handles;
      for (const auto& observed : context.observed) {
        if (retained_identities.contains(observed.identity))
          retained_handles.push_back(observed.window);
      }
      // A truncated scan has not observed every still-live HWND. Retiring its
      // unseen epochs would manufacture a new lifetime when order churn brings
      // one back into the bounded page. Keep the bounded tracker state until a
      // complete reconciliation can prove absence; capacity exhaustion is a
      // typed terminal batch failure above.
      if (!batch.windows_truncated) {
        lifetime_tracker_.reconcile(retained_handles);
      }
    }
    return batch;
  }

  ResolveStatus validate(SourceKind kind, const std::string& identity) override {
    EnumerationOptions options;
    options.kind = kind == SourceKind::Monitor
                       ? EnumerationOptions::Kind::Monitor
                       : EnumerationOptions::Kind::Window;
    const auto batch = enumerate(options);
    const auto status = kind == SourceKind::Monitor ? batch.monitors : batch.windows;
    if (status == EnumerationCompleteness::Failed) return ResolveStatus::Failed;
    const auto found = std::find_if(
        batch.candidates.begin(), batch.candidates.end(),
        [&](const SourceCandidate& candidate) {
          return candidate.kind == kind && candidate.identity == identity;
        });
    if (found != batch.candidates.end()) return ResolveStatus::Available;
    return status == EnumerationCompleteness::Complete ? ResolveStatus::Removed
                                                       : ResolveStatus::Stale;
  }

  MonitorTargetResult resolveMonitorTarget(
      const std::string& identity) override {
    if (cancelled_.load()) return {ResolveStatus::Failed, std::nullopt};
    const auto before = displayIdentities();
    if (!before.failure.empty()) return {ResolveStatus::Failed, std::nullopt};
    MonitorHandleContext context{this, &before.identities, &identity};
    const BOOL enumerated = EnumDisplayMonitors(
        nullptr, nullptr, &findMonitorHandle,
        reinterpret_cast<LPARAM>(&context));
    if (cancelled_.load() || context.api_failed ||
        (!enumerated && !context.found)) {
      return {ResolveStatus::Failed, std::nullopt};
    }
    const auto after = displayIdentities();
    if (!after.failure.empty() ||
        !sameDisplayMapping(before.identities, after.identities)) {
      return {ResolveStatus::Stale, std::nullopt};
    }
    if (!context.found) return {ResolveStatus::Removed, std::nullopt};
    return {ResolveStatus::Available,
            MonitorTargetToken{
                reinterpret_cast<std::uintptr_t>(context.found), identity}};
  }

  WindowTargetResult resolveWindowTarget(
      const std::string& identity) override {
    if (cancelled_.load()) return {ResolveStatus::Failed, std::nullopt};
    EnumerationOptions options;
    options.kind = EnumerationOptions::Kind::Window;
    options.include_own_windows = true;
    const auto batch = enumerate(options);
    if (batch.windows == EnumerationCompleteness::Failed) {
      return {ResolveStatus::Failed, std::nullopt};
    }
    const auto found = std::find_if(
        batch.candidates.begin(), batch.candidates.end(),
        [&](const SourceCandidate& candidate) {
          return candidate.kind == SourceKind::Window &&
                 candidate.identity == identity;
        });
    if (found == batch.candidates.end()) {
      return {batch.windows == EnumerationCompleteness::Complete
                  ? ResolveStatus::Removed
                  : ResolveStatus::Stale,
              std::nullopt};
    }
    const auto window = windowHandleFromIdentity(identity);
    if (!window || !IsWindow(*window)) {
      return {ResolveStatus::Removed, std::nullopt};
    }
    const auto fingerprint = windowFingerprint(*window);
    if (fingerprint.empty() ||
        !identity.starts_with(fingerprint + ":event:")) {
      return {ResolveStatus::Stale, std::nullopt};
    }
    return {ResolveStatus::Available,
            WindowTargetToken{reinterpret_cast<std::uintptr_t>(*window),
                              identity}};
  }

 private:
  static void appendOmission(EnumerationBatch& batch, const char* code,
                             const char* detail) {
    const bool present = std::any_of(
        batch.diagnostics.begin(), batch.diagnostics.end(),
        [&](const EnumerationDiagnostic& diagnostic) {
          return diagnostic.code == code;
        });
    if (present) return;
    if (batch.diagnostics.size() < kMaximumEnumerationDiagnostics) {
      batch.diagnostics.push_back({code, detail});
    }
  }

  struct WindowContext {
    struct ObservedWindow {
      std::string identity;
      std::string fingerprint;
      HWND window = nullptr;
    };
    Win32SourceEnumerator* self;
    EnumerationBatch* batch;
    bool include_own_windows;
    bool intentional_stop = false;
    bool identity_failed = false;
    bool cancelled = false;
    std::size_t visited = 0;
    std::size_t visible_candidates = 0;
    std::size_t hidden_candidates = 0;
    std::vector<ObservedWindow> observed;
  };

  struct MonitorContext {
    Win32SourceEnumerator* self;
    EnumerationBatch* batch;
    const std::vector<DisplayIdentity>* identities;
    bool intentional_stop = false;
    bool identity_failed = false;
    bool api_failed = false;
  };

  struct MonitorHandleContext {
    Win32SourceEnumerator* self;
    const std::vector<DisplayIdentity>* identities;
    const std::string* requested_identity;
    HMONITOR found = nullptr;
    bool api_failed = false;
  };

  static BOOL CALLBACK findMonitorHandle(HMONITOR monitor, HDC, LPRECT,
                                          LPARAM parameter) {
    auto* context = reinterpret_cast<MonitorHandleContext*>(parameter);
    if (context->self->cancelled_.load()) return FALSE;
    MONITORINFOEXW info{};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(monitor, &info)) {
      context->api_failed = true;
      return FALSE;
    }
    const auto match = std::find_if(
        context->identities->begin(), context->identities->end(),
        [&](const DisplayIdentity& candidate) {
          return _wcsicmp(candidate.gdi_name.c_str(), info.szDevice) == 0;
        });
    if (match != context->identities->end() &&
        match->identity == *context->requested_identity) {
      context->found = monitor;
      return FALSE;
    }
    return TRUE;
  }

  static void eraseWindows(EnumerationBatch& batch) {
    batch.candidates.erase(
        std::remove_if(batch.candidates.begin(), batch.candidates.end(),
                       [](const SourceCandidate& candidate) {
                         return candidate.kind == SourceKind::Window;
                       }),
        batch.candidates.end());
  }

  static void markCancelled(EnumerationBatch& batch,
                            const EnumerationOptions& options) {
    if (options.kind != EnumerationOptions::Kind::Window)
      batch.monitors = EnumerationCompleteness::Failed;
    if (options.kind != EnumerationOptions::Kind::Monitor)
      batch.windows = EnumerationCompleteness::Failed;
    batch.diagnostics.push_back(
        {"source_enumeration_cancelled", "registry owner requested shutdown"});
  }

  static BOOL CALLBACK enumerateMonitor(HMONITOR monitor, HDC, LPRECT,
                                         LPARAM parameter) {
    auto* context = reinterpret_cast<MonitorContext*>(parameter);
    if (context->self->cancelled_.load()) return FALSE;
    if (context->batch->candidates.size() >= kMaximumMonitors + 1) {
      context->intentional_stop = true;
      context->batch->monitors_truncated = true;
      return FALSE;
    }
    MONITORINFOEXW info{};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(monitor, &info)) {
      context->api_failed = true;
      return FALSE;
    }
    auto match = std::find_if(context->identities->begin(), context->identities->end(),
        [&](const DisplayIdentity& candidate) {
          return _wcsicmp(candidate.gdi_name.c_str(), info.szDevice) == 0;
        });
    std::string identity;
    std::string label;
    if (match != context->identities->end()) {
      identity = match->identity;
      label = match->label;
    } else {
      context->identity_failed = true;
      return FALSE;
    }
    if (label.empty()) label = utf8(info.szDevice,
        std::char_traits<wchar_t>::length(info.szDevice));
    SourceCandidate candidate;
    candidate.kind = SourceKind::Monitor;
    candidate.identity = std::move(identity);
    candidate.title = sanitizeBoundedUtf8(label, kMaximumSourceTextBytes);
    candidate.label = sanitizeBoundedUtf8(std::move(label),
                                          kMaximumSourceTextBytes);
    candidate.flags.primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
    MonitorMetadata metadata;
    metadata.logical_bounds = SourceBounds{
        static_cast<std::int32_t>(info.rcMonitor.left),
        static_cast<std::int32_t>(info.rcMonitor.top),
        static_cast<std::int32_t>(info.rcMonitor.right - info.rcMonitor.left),
        static_cast<std::int32_t>(info.rcMonitor.bottom - info.rcMonitor.top),
    };
    DEVMODEW mode{};
    mode.dmSize = sizeof(mode);
    if (EnumDisplaySettingsExW(info.szDevice, ENUM_CURRENT_SETTINGS, &mode, 0) &&
        (mode.dmFields & DM_POSITION) != 0 &&
        (mode.dmFields & DM_PELSWIDTH) != 0 &&
        (mode.dmFields & DM_PELSHEIGHT) != 0 &&
        mode.dmPelsWidth <= static_cast<DWORD>(INT32_MAX) &&
        mode.dmPelsHeight <= static_cast<DWORD>(INT32_MAX)) {
      metadata.physical_bounds = SourceBounds{
          static_cast<std::int32_t>(mode.dmPosition.x),
          static_cast<std::int32_t>(mode.dmPosition.y),
          static_cast<std::int32_t>(mode.dmPelsWidth),
          static_cast<std::int32_t>(mode.dmPelsHeight),
      };
    }
    UINT dpi_x = 0;
    UINT dpi_y = 0;
    if (SUCCEEDED(GetDpiForMonitor(monitor, MDT_RAW_DPI, &dpi_x, &dpi_y))) {
      metadata.dpi_x = dpi_x;
      metadata.dpi_y = dpi_y;
    }
    DEVICE_SCALE_FACTOR scale = SCALE_100_PERCENT;
    if (SUCCEEDED(GetScaleFactorForMonitor(monitor, &scale))) {
      metadata.scale_factor = static_cast<double>(scale) / 100.0;
    }
    candidate.monitor = metadata;
    context->batch->candidates.push_back(std::move(candidate));
    return TRUE;
  }

  void enumerateMonitors(EnumerationBatch& batch) {
    const auto identities = displayIdentities();
    if (!identities.failure.empty()) {
      batch.monitors = EnumerationCompleteness::Failed;
      batch.diagnostics.push_back({identities.failure,
                                   "canonical monitor identity was unavailable"});
      return;
    }
    const auto generation_before = test_hooks_.monitor_topology_generation
                                       ? test_hooks_.monitor_topology_generation()
                                       : 0;
    MonitorContext context{this, &batch, &identities.identities};
    const BOOL enumerated = EnumDisplayMonitors(
        nullptr, nullptr, &enumerateMonitor, reinterpret_cast<LPARAM>(&context));
    if (cancelled_.load()) {
      EnumerationOptions options;
      options.kind = EnumerationOptions::Kind::Monitor;
      batch.candidates.clear();
      markCancelled(batch, options);
      return;
    }
    if (context.identity_failed || context.api_failed ||
        (!enumerated && !context.intentional_stop)) {
      batch.monitors = EnumerationCompleteness::Failed;
      batch.diagnostics.push_back(
          {context.identity_failed
               ? "monitor_canonical_identity_unavailable"
               : (context.api_failed ? "get_monitor_info_failed"
                                     : "enum_display_monitors_failed"),
           "monitor snapshot was incomplete"});
      batch.candidates.erase(
          std::remove_if(batch.candidates.begin(), batch.candidates.end(),
                         [](const SourceCandidate& candidate) {
                           return candidate.kind == SourceKind::Monitor;
                         }),
          batch.candidates.end());
      return;
    }
    if (test_hooks_.before_monitor_post_validation)
      test_hooks_.before_monitor_post_validation();
    const auto verified = displayIdentities();
    const auto generation_after = test_hooks_.monitor_topology_generation
                                      ? test_hooks_.monitor_topology_generation()
                                      : 0;
    if (!verified.failure.empty() || generation_before != generation_after ||
        !sameDisplayMapping(identities.identities, verified.identities)) {
      batch.monitors = EnumerationCompleteness::Failed;
      appendOmission(batch, "display_topology_changed_during_enumeration",
                     "monitor mapping changed before final validation");
      batch.candidates.erase(
          std::remove_if(batch.candidates.begin(), batch.candidates.end(),
                         [](const SourceCandidate& candidate) {
                           return candidate.kind == SourceKind::Monitor;
                         }),
          batch.candidates.end());
    }
  }

  static BOOL CALLBACK enumerateWindow(HWND window, LPARAM parameter) {
    auto* context = reinterpret_cast<WindowContext*>(parameter);
    if (context->self->cancelled_.load()) {
      context->cancelled = true;
      return FALSE;
    }
    if (++context->visited > 4096) {
      context->intentional_stop = true;
      context->batch->windows_truncated = true;
      return FALSE;
    }
    const bool visible = IsWindowVisible(window) != FALSE;
    auto& category_count = visible ? context->visible_candidates
                                   : context->hidden_candidates;
    if (category_count >= kMaximumWindows) {
      context->batch->windows_truncated = true;
      return TRUE;
    }
    if (!IsWindow(window)) return TRUE;
    if (GetAncestor(window, GA_ROOT) != window) {
      appendOmission(*context->batch, "window_omitted_not_top_level",
                     "titled candidate was not a root window");
      return TRUE;
    }
    DWORD process_id = 0;
    const DWORD thread_id = GetWindowThreadProcessId(window, &process_id);
    if (process_id == 0 || thread_id == 0) return TRUE;
    const bool own = process_id == GetCurrentProcessId();
    if (own && !context->include_own_windows) {
      appendOmission(*context->batch, "window_omitted_own_process",
                     "own-process window requires the test-only override");
      return TRUE;
    }
    const auto title = windowText(window);
    if (title.empty()) {
      appendOmission(*context->batch, "window_omitted_empty_title",
                     "top-level window had no bounded caption");
      return TRUE;
    }
    const std::string bounded_title =
        sanitizeBoundedUtf8(utf8(title), kMaximumSourceTextBytes);
    if (context->self->test_hooks_.include_window_title &&
        !context->self->test_hooks_.include_window_title(bounded_title)) {
      return TRUE;
    }
    RECT bounds{};
    const bool valid_bounds = GetWindowRect(window, &bounds) != FALSE &&
                              bounds.right > bounds.left &&
                              bounds.bottom > bounds.top;
    DWORD cloaked = 0;
    const bool is_cloaked =
        SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked,
                                        sizeof(cloaked))) &&
        cloaked != 0;
    wchar_t class_name[256]{};
    const int class_length = GetClassNameW(window, class_name,
                                           static_cast<int>(std::size(class_name)));
    SourceCandidate candidate;
    candidate.kind = SourceKind::Window;
    const auto lifetime_suffix = context->self->lifetime_tracker_.suffix(window);
    if (!lifetime_suffix) {
      context->identity_failed = true;
      return FALSE;
    }
    const std::string fingerprint =
        "window:" + hexValue(reinterpret_cast<std::uintptr_t>(window)) + ":" +
        std::to_string(process_id) + ":" +
        std::to_string(processCreation(process_id)) + ":" +
        std::to_string(thread_id) + ":" +
        utf8(class_name, class_length > 0
                             ? static_cast<std::size_t>(class_length)
                             : 0);
    candidate.identity = fingerprint + *lifetime_suffix;
    candidate.title = bounded_title;
    candidate.label = applicationLabel(process_id);
    if (candidate.label.empty()) {
      appendOmission(*context->batch, "window_process_metadata_unavailable",
                     "process image basename could not be queried safely");
    }
    candidate.flags.visible = visible;
    candidate.flags.minimized = IsIconic(window) != FALSE;
    candidate.flags.own_process = own;
    if (!candidate.flags.visible) {
      candidate.exclusions.push_back(ExclusionReason::NotVisible);
    }
    if (!valid_bounds) {
      candidate.exclusions.push_back(ExclusionReason::InvalidBounds);
    }
    if (is_cloaked) candidate.exclusions.push_back(ExclusionReason::Cloaked);
    if (own) candidate.exclusions.push_back(ExclusionReason::OwnProcess);
    context->observed.push_back({candidate.identity, fingerprint, window});
    context->batch->candidates.push_back(std::move(candidate));
    ++category_count;
    if (context->self->test_hooks_.after_window_observed) {
      context->self->test_hooks_.after_window_observed(bounded_title);
    }
    return TRUE;
  }

  Win32SourceEnumeratorTestHooks test_hooks_;
  WindowLifetimeTracker lifetime_tracker_;
  std::atomic<bool> cancelled_{false};
};

}  // namespace

std::unique_ptr<SourceEnumerator> createWin32SourceEnumerator(
    Win32SourceEnumeratorTestHooks test_hooks) {
  return std::make_unique<Win32SourceEnumerator>(std::move(test_hooks));
}

}  // namespace syrnike::windows_media::sources
