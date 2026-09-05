#pragma once

#include <cstddef>
#include <cstdint>
#include <atomic>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace syrnike::windows_media::sources {

inline constexpr std::size_t kMaximumMonitors = 8;
inline constexpr std::size_t kMaximumWindows = 256;
inline constexpr std::size_t kMaximumSourceTextBytes = 256;
inline constexpr std::size_t kMaximumEnumerationDiagnostics = 64;
inline constexpr std::size_t kMaximumSourceExclusions = 8;
inline constexpr std::size_t kMaximumRemovedTombstones = 512;
inline constexpr std::size_t kMaximumTrackedMonitors = 16;
inline constexpr std::size_t kMaximumTrackedWindows = 512;

enum class SourceKind { Monitor, Window };
enum class SourceAvailability { Available, Unavailable };
enum class CaptureSupport { Unknown, Unsupported };
enum class EnumerationCompleteness { Complete, Partial, Failed };
enum class ResolveStatus { Available, Removed, Stale, Unknown, Failed };
enum class ExclusionReason {
  NotVisible,
  NotTopLevel,
  EmptyTitle,
  OwnProcess,
  Cloaked,
  InvalidBounds,
};

struct SourceFlags {
  bool visible = true;
  bool minimized = false;
  bool primary = false;
  bool own_process = false;
};

struct SourceBounds {
  std::int32_t x = 0;
  std::int32_t y = 0;
  std::int32_t width = 0;
  std::int32_t height = 0;
};

struct MonitorMetadata {
  SourceBounds logical_bounds;
  std::optional<SourceBounds> physical_bounds;
  std::optional<std::uint32_t> dpi_x;
  std::optional<std::uint32_t> dpi_y;
  std::optional<double> scale_factor;
};

// SourceCandidate is the bounded value seam implemented by platform adapters.
// identity is private to the registry/adapter boundary and is never returned to
// a product caller. It must identify one observed platform-object lifetime.
struct SourceCandidate {
  SourceKind kind = SourceKind::Window;
  std::string identity;
  std::string title;
  std::string label;
  SourceFlags flags;
  SourceAvailability availability = SourceAvailability::Available;
  CaptureSupport capture_support = CaptureSupport::Unknown;
  std::vector<ExclusionReason> exclusions;
  std::optional<MonitorMetadata> monitor;
};

struct EnumerationOptions {
  enum class Kind { All, Monitor, Window };
  Kind kind = Kind::All;
  bool include_own_windows = false;
};

struct EnumerationDiagnostic {
  std::string code;
  std::string detail;
};

struct EnumerationBatch {
  std::vector<SourceCandidate> candidates;
  std::vector<EnumerationDiagnostic> diagnostics;
  EnumerationCompleteness monitors = EnumerationCompleteness::Complete;
  EnumerationCompleteness windows = EnumerationCompleteness::Complete;
  bool monitors_truncated = false;
  bool windows_truncated = false;
};

// Internal native token consumed only by capture adapters. Product callers and
// JSON snapshots never receive or serialize the platform value.
class MonitorTargetToken final {
 public:
  MonitorTargetToken() = default;
  explicit MonitorTargetToken(std::uintptr_t platform_value,
                              std::string cache_key = {})
      : platform_value_(platform_value), cache_key_(std::move(cache_key)) {}
  bool valid() const noexcept { return platform_value_ != 0; }
  std::uintptr_t platformValue() const noexcept { return platform_value_; }
  const std::string& cacheKey() const noexcept { return cache_key_; }

 private:
  std::uintptr_t platform_value_ = 0;
  std::string cache_key_;
};

struct MonitorTargetResult {
  ResolveStatus status = ResolveStatus::Unknown;
  std::optional<MonitorTargetToken> target;
};

// Internal native token for one validated HWND lifetime. The cache key carries
// the full registry identity, so a recycled HWND cannot alias an older target.
class WindowTargetToken final {
 public:
  WindowTargetToken() = default;
  explicit WindowTargetToken(std::uintptr_t platform_value,
                             std::string cache_key = {})
      : platform_value_(platform_value), cache_key_(std::move(cache_key)) {}
  bool valid() const noexcept { return platform_value_ != 0; }
  std::uintptr_t platformValue() const noexcept { return platform_value_; }
  const std::string& cacheKey() const noexcept { return cache_key_; }

 private:
  std::uintptr_t platform_value_ = 0;
  std::string cache_key_;
};

struct WindowTargetResult {
  ResolveStatus status = ResolveStatus::Unknown;
  std::optional<WindowTargetToken> target;
};

class SourceEnumerator {
 public:
  virtual ~SourceEnumerator() = default;
  virtual EnumerationBatch enumerate(const EnumerationOptions& options) = 0;
  virtual ResolveStatus validate(SourceKind kind,
                                 const std::string& identity) = 0;
  virtual MonitorTargetResult resolveMonitorTarget(const std::string& identity);
  virtual WindowTargetResult resolveWindowTarget(const std::string& identity);
  virtual void requestStop() noexcept {}
};

struct SourceSnapshot {
  std::string id;
  SourceKind kind = SourceKind::Window;
  std::string title;
  std::string label;
  SourceFlags flags;
  SourceAvailability availability = SourceAvailability::Available;
  CaptureSupport capture_support = CaptureSupport::Unknown;
  std::vector<ExclusionReason> exclusions;
  std::optional<MonitorMetadata> monitor;
};

struct SourceEnumeration {
  std::vector<SourceSnapshot> sources;
  std::vector<EnumerationDiagnostic> diagnostics;
  bool monitors_truncated = false;
  bool windows_truncated = false;
  bool complete = true;
  bool ok = true;
  EnumerationCompleteness monitors = EnumerationCompleteness::Complete;
  EnumerationCompleteness windows = EnumerationCompleteness::Complete;
  std::vector<std::string> added_ids;
  std::vector<std::string> updated_ids;
  struct RemovedSource {
    std::string id;
    SourceKind kind = SourceKind::Window;
    SourceAvailability availability = SourceAvailability::Unavailable;
  };
  std::vector<RemovedSource> removed;
};

struct ResolveResult {
  ResolveStatus status = ResolveStatus::Unknown;
  std::string id;
  std::optional<SourceKind> kind;
};

class SourceRegistry final {
 public:
  explicit SourceRegistry(std::unique_ptr<SourceEnumerator> enumerator);
  ~SourceRegistry();
  SourceRegistry(const SourceRegistry&) = delete;
  SourceRegistry& operator=(const SourceRegistry&) = delete;

  SourceEnumeration enumerate(const EnumerationOptions& options = {});
  ResolveResult resolve(const std::string& id);
  MonitorTargetResult resolveMonitorTarget(const std::string& id);
  WindowTargetResult resolveWindowTarget(const std::string& id);
  void shutdown() noexcept;

 private:
  struct Entry {
    std::string id;
    SourceKind kind = SourceKind::Window;
    bool own_window = false;
    std::string identity;
    SourceSnapshot snapshot;
  };

  struct Tombstone {
    std::string id;
    SourceKind kind = SourceKind::Window;
  };

  std::string nextId();

  std::unique_ptr<SourceEnumerator> enumerator_;
  std::unordered_map<std::string, Entry> active_;
  std::deque<Tombstone> tombstones_;
  std::uint64_t nonce_ = 0;
  std::uint64_t next_id_ = 1;
  std::mutex mutex_;
  std::atomic<bool> stopping_{false};
};

const char* toString(SourceKind value) noexcept;
const char* toString(SourceAvailability value) noexcept;
const char* toString(CaptureSupport value) noexcept;
const char* toString(ExclusionReason value) noexcept;
const char* toString(EnumerationCompleteness value) noexcept;
const char* toString(ResolveStatus value) noexcept;

}  // namespace syrnike::windows_media::sources
