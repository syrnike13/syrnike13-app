#include "sources/source_registry.hpp"
#include "sources/utf8.hpp"

#include <algorithm>
#include <iomanip>
#include <random>
#include <sstream>
#include <stdexcept>
#include <unordered_set>

namespace syrnike::windows_media::sources {
namespace {

bool sameBounds(const SourceBounds& left, const SourceBounds& right) {
  return left.x == right.x && left.y == right.y &&
         left.width == right.width && left.height == right.height;
}

bool sameMonitor(const std::optional<MonitorMetadata>& left,
                 const std::optional<MonitorMetadata>& right) {
  if (left.has_value() != right.has_value()) return false;
  if (!left) return true;
  const bool physical_equal =
      left->physical_bounds.has_value() == right->physical_bounds.has_value() &&
      (!left->physical_bounds ||
       sameBounds(*left->physical_bounds, *right->physical_bounds));
  return sameBounds(left->logical_bounds, right->logical_bounds) &&
         physical_equal && left->dpi_x == right->dpi_x &&
         left->dpi_y == right->dpi_y &&
         left->scale_factor == right->scale_factor;
}

bool sameSnapshot(const SourceSnapshot& left, const SourceSnapshot& right) {
  return left.kind == right.kind && left.title == right.title &&
         left.label == right.label && left.flags.visible == right.flags.visible &&
         left.flags.minimized == right.flags.minimized &&
         left.flags.primary == right.flags.primary &&
         left.flags.own_process == right.flags.own_process &&
         left.availability == right.availability &&
         left.capture_support == right.capture_support &&
         left.exclusions == right.exclusions && sameMonitor(left.monitor, right.monitor);
}

bool kindRequested(SourceKind kind, const EnumerationOptions& options) {
  return options.kind == EnumerationOptions::Kind::All ||
         (kind == SourceKind::Monitor &&
          options.kind == EnumerationOptions::Kind::Monitor) ||
         (kind == SourceKind::Window &&
          options.kind == EnumerationOptions::Kind::Window);
}

}  // namespace

MonitorTargetResult SourceEnumerator::resolveMonitorTarget(
    const std::string& identity) {
  (void)identity;
  return {ResolveStatus::Failed, std::nullopt};
}

WindowTargetResult SourceEnumerator::resolveWindowTarget(
    const std::string& identity) {
  (void)identity;
  return {ResolveStatus::Failed, std::nullopt};
}

SourceRegistry::SourceRegistry(std::unique_ptr<SourceEnumerator> enumerator)
    : enumerator_(std::move(enumerator)) {
  if (!enumerator_) throw std::invalid_argument("SourceEnumerator is required");
  std::random_device random;
  nonce_ = (static_cast<std::uint64_t>(random()) << 32U) ^ random();
}

SourceRegistry::~SourceRegistry() { shutdown(); }

void SourceRegistry::shutdown() noexcept {
  const bool already_stopping = stopping_.exchange(true);
  if (!already_stopping) enumerator_->requestStop();
  std::lock_guard lock(mutex_);
}

std::string SourceRegistry::nextId() {
  std::ostringstream value;
  value << "src_" << std::hex << std::setfill('0') << std::setw(16) << nonce_
        << std::setw(16) << next_id_++;
  return value.str();
}

SourceEnumeration SourceRegistry::enumerate(const EnumerationOptions& options) {
  if (stopping_.load()) {
    SourceEnumeration stopped;
    stopped.ok = false;
    stopped.complete = false;
    if (kindRequested(SourceKind::Monitor, options))
      stopped.monitors = EnumerationCompleteness::Failed;
    if (kindRequested(SourceKind::Window, options))
      stopped.windows = EnumerationCompleteness::Failed;
    stopped.diagnostics.push_back(
        {"source_registry_stopped", "registry owner requested bounded shutdown"});
    return stopped;
  }
  std::unique_lock lock(mutex_, std::try_to_lock);
  if (!lock.owns_lock()) {
    SourceEnumeration busy;
    busy.ok = false;
    busy.complete = false;
    if (kindRequested(SourceKind::Monitor, options))
      busy.monitors = EnumerationCompleteness::Partial;
    if (kindRequested(SourceKind::Window, options))
      busy.windows = EnumerationCompleteness::Partial;
    busy.diagnostics.push_back(
        {"enumeration_in_progress", "only one enumeration may run at a time"});
    return busy;
  }
  auto batch = enumerator_->enumerate(options);
  SourceEnumeration result;
  if (stopping_.load()) {
    result.ok = false;
    result.complete = false;
    if (kindRequested(SourceKind::Monitor, options))
      result.monitors = EnumerationCompleteness::Failed;
    if (kindRequested(SourceKind::Window, options))
      result.windows = EnumerationCompleteness::Failed;
    result.diagnostics.push_back(
        {"source_registry_stopped", "enumeration was cancelled during shutdown"});
    return result;
  }
  result.diagnostics = std::move(batch.diagnostics);
  if (result.diagnostics.size() > kMaximumEnumerationDiagnostics) {
    result.diagnostics.resize(kMaximumEnumerationDiagnostics);
  }
  for (auto& diagnostic : result.diagnostics) {
    diagnostic.code = sanitizeBoundedUtf8(std::move(diagnostic.code),
                                          kMaximumSourceTextBytes);
    diagnostic.detail = sanitizeBoundedUtf8(std::move(diagnostic.detail),
                                            kMaximumSourceTextBytes);
  }
  const bool monitors_requested = kindRequested(SourceKind::Monitor, options);
  const bool windows_requested = kindRequested(SourceKind::Window, options);
  result.monitors = batch.monitors_truncated ? EnumerationCompleteness::Partial
                                             : batch.monitors;
  result.windows = batch.windows_truncated ? EnumerationCompleteness::Partial
                                           : batch.windows;
  if ((monitors_requested && batch.monitors == EnumerationCompleteness::Failed) ||
      (windows_requested && batch.windows == EnumerationCompleteness::Failed)) {
    result.ok = false;
    result.complete = false;
    return result;
  }

  std::unordered_map<std::string, Entry> next;
  std::unordered_set<std::string> seen;
  std::size_t monitor_count = 0;
  std::size_t window_count = 0;

  auto monitor_status = batch.monitors_truncated
                            ? EnumerationCompleteness::Partial
                            : batch.monitors;
  auto window_status = batch.windows_truncated
                           ? EnumerationCompleteness::Partial
                           : batch.windows;
  result.monitors = monitor_status;
  result.windows = window_status;

  std::vector<SourceCandidate> selected;
  selected.reserve(std::min(batch.candidates.size(),
                            kMaximumMonitors + kMaximumWindows));

  for (auto& candidate : batch.candidates) {
    if (candidate.identity.empty() || !seen.insert(candidate.identity).second) {
      if (result.diagnostics.size() < kMaximumEnumerationDiagnostics) {
        result.diagnostics.push_back({"duplicate_platform_identity",
                                      "adapter candidate was omitted"});
      }
      continue;
    }
    auto& count = candidate.kind == SourceKind::Monitor ? monitor_count
                                                        : window_count;
    const auto limit = candidate.kind == SourceKind::Monitor ? kMaximumMonitors
                                                             : kMaximumWindows;
    if (count >= limit) {
      if (candidate.kind == SourceKind::Monitor)
        result.monitors_truncated = true;
      else
        result.windows_truncated = true;
      continue;
    }
    ++count;

    selected.push_back(std::move(candidate));
  }
  result.monitors_truncated = result.monitors_truncated || batch.monitors_truncated;
  result.windows_truncated = result.windows_truncated || batch.windows_truncated;
  if (result.monitors_truncated) monitor_status = EnumerationCompleteness::Partial;
  if (result.windows_truncated) window_status = EnumerationCompleteness::Partial;
  result.monitors = monitor_status;
  result.windows = window_status;
  result.complete = (!monitors_requested || monitor_status == EnumerationCompleteness::Complete) &&
                    (!windows_requested || window_status == EnumerationCompleteness::Complete);
  if (result.monitors_truncated || result.windows_truncated) result.complete = false;

  for (const auto& [identity, entry] : active_) {
    const auto status = entry.kind == SourceKind::Monitor ? monitor_status
                                                          : window_status;
    if (!kindRequested(entry.kind, options) ||
        status != EnumerationCompleteness::Complete) {
      next.emplace(identity, entry);
    }
  }

  const auto projectedCount = [&](SourceKind kind) {
    std::size_t count = 0;
    std::unordered_set<std::string> identities;
    for (const auto& [identity, entry] : next) {
      if (entry.kind == kind && identities.insert(identity).second) ++count;
    }
    for (const auto& candidate : selected) {
      if (candidate.kind == kind && identities.insert(candidate.identity).second) ++count;
    }
    return count;
  };
  if (projectedCount(SourceKind::Monitor) > kMaximumTrackedMonitors ||
      projectedCount(SourceKind::Window) > kMaximumTrackedWindows) {
    result.ok = false;
    result.complete = false;
    result.sources.clear();
    if (result.diagnostics.size() < kMaximumEnumerationDiagnostics) {
      result.diagnostics.push_back(
          {"source_registry_capacity_exceeded",
           "partial reconciliation would exceed bounded identity state"});
    }
    return result;
  }

  std::unordered_set<std::string> selected_identities;
  for (auto& candidate : selected) {
    candidate.title = sanitizeBoundedUtf8(std::move(candidate.title),
                                          kMaximumSourceTextBytes);
    candidate.label = sanitizeBoundedUtf8(std::move(candidate.label),
                                          kMaximumSourceTextBytes);
    if (candidate.exclusions.size() > kMaximumSourceExclusions) {
      candidate.exclusions.resize(kMaximumSourceExclusions);
    }
    selected_identities.insert(candidate.identity);
    auto found = active_.find(candidate.identity);
    const auto id = found == active_.end() ? nextId() : found->second.id;
    const bool own_window = std::find(candidate.exclusions.begin(),
                                      candidate.exclusions.end(),
                                      ExclusionReason::OwnProcess) !=
                            candidate.exclusions.end();
    SourceSnapshot snapshot{id,
                            candidate.kind,
                            std::move(candidate.title),
                            std::move(candidate.label),
                            candidate.flags,
                            candidate.availability,
                            candidate.capture_support,
                            std::move(candidate.exclusions),
                            candidate.monitor};
    result.sources.push_back(snapshot);
    if (found == active_.end()) result.added_ids.push_back(id);
    else if (!sameSnapshot(found->second.snapshot, snapshot))
      result.updated_ids.push_back(id);
    next.insert_or_assign(candidate.identity,
                          Entry{id, candidate.kind, own_window,
                                candidate.identity, snapshot});
  }

  for (const auto& [identity, entry] : active_) {
    if (!kindRequested(entry.kind, options)) continue;
    const auto status = entry.kind == SourceKind::Monitor ? monitor_status
                                                          : window_status;
    if (status != EnumerationCompleteness::Complete ||
        selected_identities.contains(identity)) {
      continue;
    }
    SourceEnumeration::RemovedSource removed{entry.id, entry.kind,
                                              SourceAvailability::Unavailable};
    result.removed.push_back(removed);
    tombstones_.push_back(Tombstone{entry.id, entry.kind});
    if (tombstones_.size() > kMaximumRemovedTombstones) tombstones_.pop_front();
  }
  active_ = std::move(next);
  return result;
}

ResolveResult SourceRegistry::resolve(const std::string& id) {
  if (stopping_.load()) {
    return ResolveResult{ResolveStatus::Failed, id, std::nullopt};
  }
  std::lock_guard lock(mutex_);
  if (stopping_.load()) {
    return ResolveResult{ResolveStatus::Failed, id, std::nullopt};
  }
  for (const auto& [identity, entry] : active_) {
    (void)identity;
    if (entry.id == id) {
      return ResolveResult{enumerator_->validate(entry.kind, entry.identity),
                           id, entry.kind};
    }
  }
  for (const auto& tombstone : tombstones_) {
    if (tombstone.id == id) {
      return ResolveResult{ResolveStatus::Removed, id, tombstone.kind};
    }
  }
  return ResolveResult{ResolveStatus::Unknown, id, std::nullopt};
}

MonitorTargetResult SourceRegistry::resolveMonitorTarget(
    const std::string& id) {
  if (stopping_.load()) return {ResolveStatus::Failed, std::nullopt};
  std::lock_guard lock(mutex_);
  if (stopping_.load()) return {ResolveStatus::Failed, std::nullopt};
  for (const auto& [identity, entry] : active_) {
    (void)identity;
    if (entry.id != id) continue;
    if (entry.kind != SourceKind::Monitor) {
      return {ResolveStatus::Failed, std::nullopt};
    }
    auto result = enumerator_->resolveMonitorTarget(entry.identity);
    if (stopping_.load()) {
      return {ResolveStatus::Failed, std::nullopt};
    }
    if (result.status != ResolveStatus::Available || !result.target ||
        !result.target->valid()) {
      result.target.reset();
    }
    return result;
  }
  for (const auto& tombstone : tombstones_) {
    if (tombstone.id == id) {
      return {ResolveStatus::Removed, std::nullopt};
    }
  }
  return {ResolveStatus::Unknown, std::nullopt};
}

WindowTargetResult SourceRegistry::resolveWindowTarget(
    const std::string& id) {
  if (stopping_.load()) return {ResolveStatus::Failed, std::nullopt};
  std::lock_guard lock(mutex_);
  if (stopping_.load()) return {ResolveStatus::Failed, std::nullopt};
  for (const auto& [identity, entry] : active_) {
    (void)identity;
    if (entry.id != id) continue;
    if (entry.kind != SourceKind::Window) {
      return {ResolveStatus::Failed, std::nullopt};
    }
    auto result = enumerator_->resolveWindowTarget(entry.identity);
    if (stopping_.load()) {
      return {ResolveStatus::Failed, std::nullopt};
    }
    if (result.status != ResolveStatus::Available || !result.target ||
        !result.target->valid()) {
      result.target.reset();
    }
    return result;
  }
  for (const auto& tombstone : tombstones_) {
    if (tombstone.id == id) {
      return {ResolveStatus::Removed, std::nullopt};
    }
  }
  return {ResolveStatus::Unknown, std::nullopt};
}

const char* toString(SourceKind value) noexcept {
  return value == SourceKind::Monitor ? "monitor" : "window";
}

const char* toString(SourceAvailability value) noexcept {
  return value == SourceAvailability::Available ? "available" : "unavailable";
}

const char* toString(CaptureSupport value) noexcept {
  return value == CaptureSupport::Unsupported ? "unsupported" : "unknown";
}

const char* toString(ExclusionReason value) noexcept {
  switch (value) {
    case ExclusionReason::NotVisible: return "not_visible";
    case ExclusionReason::NotTopLevel: return "not_top_level";
    case ExclusionReason::EmptyTitle: return "empty_title";
    case ExclusionReason::OwnProcess: return "own_process";
    case ExclusionReason::Cloaked: return "cloaked";
    case ExclusionReason::InvalidBounds: return "invalid_bounds";
  }
  return "unknown";
}

const char* toString(EnumerationCompleteness value) noexcept {
  switch (value) {
    case EnumerationCompleteness::Complete: return "complete";
    case EnumerationCompleteness::Partial: return "partial";
    case EnumerationCompleteness::Failed: return "failed";
  }
  return "failed";
}

const char* toString(ResolveStatus value) noexcept {
  switch (value) {
    case ResolveStatus::Available: return "available";
    case ResolveStatus::Removed: return "removed";
    case ResolveStatus::Stale: return "stale";
    case ResolveStatus::Unknown: return "unknown";
    case ResolveStatus::Failed: return "failed";
  }
  return "failed";
}

}  // namespace syrnike::windows_media::sources
