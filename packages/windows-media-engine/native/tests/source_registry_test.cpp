#include <algorithm>
#include <condition_variable>
#include <memory>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "sources/source_registry.hpp"

namespace {

using namespace syrnike::windows_media::sources;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

class FakeEnumerator final : public SourceEnumerator {
 public:
  std::vector<SourceCandidate> candidates;
  EnumerationCompleteness monitors = EnumerationCompleteness::Complete;
  EnumerationCompleteness windows = EnumerationCompleteness::Complete;
  bool monitors_truncated = false;
  bool windows_truncated = false;
  std::vector<EnumerationDiagnostic> diagnostics;
  std::unordered_map<std::string, ResolveStatus> validations;
  std::size_t validation_calls = 0;

  EnumerationBatch enumerate(const EnumerationOptions& options) override {
    EnumerationBatch batch;
    for (const auto& value : candidates) {
      if (options.kind == EnumerationOptions::Kind::All ||
          (options.kind == EnumerationOptions::Kind::Monitor &&
           value.kind == SourceKind::Monitor) ||
          (options.kind == EnumerationOptions::Kind::Window &&
           value.kind == SourceKind::Window)) {
        batch.candidates.push_back(value);
      }
    }
    batch.monitors = monitors;
    batch.windows = windows;
    batch.monitors_truncated = monitors_truncated;
    batch.windows_truncated = windows_truncated;
    batch.diagnostics = diagnostics;
    return batch;
  }

  ResolveStatus validate(SourceKind, const std::string& identity) override {
    ++validation_calls;
    const auto overridden = validations.find(identity);
    if (overridden != validations.end()) return overridden->second;
    return std::any_of(candidates.begin(), candidates.end(),
                       [&](const SourceCandidate& value) {
                         return value.identity == identity;
                       })
               ? ResolveStatus::Available
               : ResolveStatus::Removed;
  }
};

SourceCandidate candidate(SourceKind kind, std::string identity,
                          std::string title) {
  SourceCandidate value;
  value.kind = kind;
  value.identity = std::move(identity);
  value.title = std::move(title);
  value.label = value.title;
  return value;
}

void partialEnumerationPreservesIdentityAndSuppressesRemoval() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  fake->candidates = {candidate(SourceKind::Window, "partial-window", "Window")};
  SourceRegistry registry(std::move(adapter));
  const auto first = registry.enumerate();
  const std::string id = first.sources[0].id;

  fake->candidates.clear();
  fake->windows = EnumerationCompleteness::Partial;
  fake->validations["partial-window"] = ResolveStatus::Stale;
  const auto partial = registry.enumerate();
  require(!partial.complete &&
              partial.windows == EnumerationCompleteness::Partial &&
              partial.monitors == EnumerationCompleteness::Complete &&
              partial.removed.empty() &&
              registry.resolve(id).status == ResolveStatus::Stale,
          "partial enumeration removed or trusted an unseen live identity");

  fake->windows = EnumerationCompleteness::Complete;
  fake->validations.clear();
  fake->candidates = {candidate(SourceKind::Window, "partial-window", "Window")};
  const auto restored = registry.enumerate();
  require(restored.sources[0].id == id,
          "partial enumeration did not preserve the live opaque ID");
}

void completeRemovalIsTypedAndResolvable() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  fake->candidates = {candidate(SourceKind::Window, "removed-window", "Window")};
  SourceRegistry registry(std::move(adapter));
  const auto first = registry.enumerate();
  const std::string id = first.sources[0].id;
  require(registry.resolve(id).status == ResolveStatus::Available,
          "live source did not resolve as available");
  fake->candidates.clear();
  const auto removed = registry.enumerate();
  require(removed.removed.size() == 1 && removed.removed[0].id == id &&
              removed.removed[0].kind == SourceKind::Window &&
              registry.resolve(id).status == ResolveStatus::Removed,
          "complete reconciliation did not expose a typed removed ID");
}

void truncatedOrderChurnPreservesIssuedIds() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  for (std::size_t index = 0; index < kMaximumWindows + 20; ++index) {
    fake->candidates.push_back(candidate(
        SourceKind::Window, "ordered-" + std::to_string(index), "Window"));
  }
  fake->windows_truncated = true;
  SourceRegistry registry(std::move(adapter));
  const auto first = registry.enumerate();
  const std::string first_id = first.sources[0].id;
  std::rotate(fake->candidates.begin(), fake->candidates.begin() + 17,
              fake->candidates.end());
  registry.enumerate();
  std::rotate(fake->candidates.rbegin(), fake->candidates.rbegin() + 17,
              fake->candidates.rend());
  const auto restored = registry.enumerate();
  require(restored.sources[0].id == first_id && restored.removed.empty(),
          "truncated order churn retired a previously issued window ID");

  fake->candidates.clear();
  for (std::size_t index = 0; index < kMaximumMonitors + 1; ++index) {
    fake->candidates.push_back(candidate(
        SourceKind::Monitor, "monitor-order-" + std::to_string(index), "Display"));
  }
  fake->windows_truncated = false;
  fake->monitors_truncated = true;
  const auto monitor_first = registry.enumerate();
  const std::string monitor_id = monitor_first.sources[0].id;
  std::rotate(fake->candidates.begin(), fake->candidates.begin() + 1,
              fake->candidates.end());
  registry.enumerate();
  std::rotate(fake->candidates.rbegin(), fake->candidates.rbegin() + 1,
              fake->candidates.rend());
  const auto monitor_restored = registry.enumerate();
  require(monitor_restored.sources[0].id == monitor_id,
          "truncated order churn retired a previously issued monitor ID");
}

void ownProcessFilterCannotRetainClosedEntries() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  auto own = candidate(SourceKind::Window, "own-window", "Own");
  own.flags.own_process = true;
  own.exclusions.push_back(ExclusionReason::OwnProcess);
  fake->candidates = {own};
  SourceRegistry registry(std::move(adapter));
  EnumerationOptions include;
  include.kind = EnumerationOptions::Kind::Window;
  include.include_own_windows = true;
  const std::string id = registry.enumerate(include).sources[0].id;
  fake->candidates.clear();
  EnumerationOptions defaults;
  defaults.kind = EnumerationOptions::Kind::Window;
  const auto closed = registry.enumerate(defaults);
  require(closed.removed.size() == 1 && closed.removed[0].id == id &&
              registry.resolve(id).status == ResolveStatus::Removed,
          "default enumeration retained a closed test-only own window");
}

void sameHandleNewLifetimeGetsNewOpaqueId() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  fake->candidates = {
      candidate(SourceKind::Window, "hwnd-42:event-1", "Window")};
  SourceRegistry registry(std::move(adapter));
  const auto first = registry.enumerate();
  fake->candidates = {
      candidate(SourceKind::Window, "hwnd-42:event-2", "Window")};
  const auto recycled = registry.enumerate();
  require(recycled.sources[0].id != first.sources[0].id &&
              recycled.removed.size() == 1 &&
              recycled.removed[0].id == first.sources[0].id,
          "same platform handle with a new lifetime epoch reused identity");
}

void stableIdentitySurvivesMetadataChanges() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  fake->candidates = {candidate(SourceKind::Window, "lifetime-a", "First title")};
  SourceRegistry registry(std::move(adapter));

  const auto first = registry.enumerate();
  require(first.sources.size() == 1, "first source was not enumerated");
  require(!first.sources[0].id.empty(), "source ID was empty");

  fake->candidates[0].title = "Renamed title";
  const auto second = registry.enumerate();
  require(second.sources.size() == 1, "renamed source disappeared");
  require(second.sources[0].id == first.sources[0].id,
          "metadata change replaced the source ID");
  require(second.sources[0].title == "Renamed title",
          "metadata change was not reflected in the snapshot");
}

void removedIdentityIsNeverRemapped() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  fake->candidates = {candidate(SourceKind::Window, "recycled-key", "First")};
  SourceRegistry registry(std::move(adapter));
  const auto first_id = registry.enumerate().sources.at(0).id;
  fake->candidates.clear();
  require(registry.enumerate().sources.empty(), "removed source remained active");
  fake->candidates = {candidate(SourceKind::Window, "recycled-key", "Second")};
  const auto second_id = registry.enumerate().sources.at(0).id;
  require(second_id != first_id, "removed platform lifetime reused an opaque ID");
}

void duplicatePlatformIdentityIsOmitted() {
  auto adapter = std::make_unique<FakeEnumerator>();
  adapter->candidates = {
      candidate(SourceKind::Window, "collision", "One"),
      candidate(SourceKind::Window, "collision", "Two"),
  };
  SourceRegistry registry(std::move(adapter));
  const auto result = registry.enumerate();
  require(result.sources.size() == 1, "identity collision escaped registry");
  require(result.diagnostics.size() == 1 &&
              result.diagnostics[0].code == "duplicate_platform_identity",
          "identity collision was not typed");
}

void monitorLabelsDoNotDefineIdentity() {
  auto adapter = std::make_unique<FakeEnumerator>();
  adapter->candidates = {
      candidate(SourceKind::Monitor, "monitor-a", "Same display"),
      candidate(SourceKind::Monitor, "monitor-b", "Same display"),
  };
  SourceRegistry registry(std::move(adapter));
  const auto result = registry.enumerate();
  require(result.sources.size() == 2, "same-label monitors were collapsed");
  require(result.sources[0].id != result.sources[1].id,
          "same-label monitors shared an opaque ID");
}

void monitorMetadataUpdatesWithoutReplacingIdentity() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  auto monitor = candidate(SourceKind::Monitor, "monitor-metadata", "Display");
  monitor.availability = SourceAvailability::Available;
  monitor.flags.primary = false;
  monitor.monitor = MonitorMetadata{
      .logical_bounds = SourceBounds{10, 20, 1920, 1080},
      .physical_bounds = SourceBounds{20, 40, 3840, 2160},
      .dpi_x = 192,
      .dpi_y = 192,
      .scale_factor = 2.0,
  };
  fake->candidates = {monitor};
  SourceRegistry registry(std::move(adapter));
  const auto first = registry.enumerate();
  require(first.sources[0].monitor.has_value(),
          "monitor metadata was absent at the public boundary");
  require(first.sources[0].monitor->logical_bounds.width == 1920 &&
              first.sources[0].monitor->physical_bounds->width == 3840 &&
              first.sources[0].monitor->dpi_x == 192U &&
              first.sources[0].monitor->dpi_y == 192U &&
              first.sources[0].monitor->scale_factor == 2.0 &&
              first.sources[0].availability == SourceAvailability::Available,
          "required monitor metadata changed at the public boundary");
  const auto id = first.sources[0].id;

  fake->candidates[0].flags.primary = true;
  fake->candidates[0].monitor->logical_bounds.x = -1920;
  fake->candidates[0].monitor->dpi_x = 144;
  fake->candidates[0].monitor->dpi_y = 144;
  fake->candidates[0].monitor->scale_factor = 1.5;
  const auto updated = registry.enumerate();
  require(updated.sources[0].id == id && updated.sources[0].flags.primary &&
              updated.sources[0].monitor->logical_bounds.x == -1920 &&
              updated.sources[0].monitor->dpi_x == 144U,
          "monitor metadata update replaced identity or stayed stale");

  fake->candidates[0].monitor->physical_bounds.reset();
  fake->candidates[0].monitor->dpi_x.reset();
  fake->candidates[0].monitor->dpi_y.reset();
  fake->candidates[0].monitor->scale_factor.reset();
  const auto unknown = registry.enumerate();
  require(unknown.sources[0].id == id &&
              !unknown.sources[0].monitor->physical_bounds &&
              !unknown.sources[0].monitor->dpi_x &&
              !unknown.sources[0].monitor->dpi_y &&
              !unknown.sources[0].monitor->scale_factor,
          "unknown monitor metadata was replaced with invented precision");
}

void kindFiltersDoNotRetireUnobservedLiveSources() {
  auto adapter = std::make_unique<FakeEnumerator>();
  adapter->candidates = {
      candidate(SourceKind::Monitor, "monitor", "Display"),
      candidate(SourceKind::Window, "window", "Window"),
  };
  SourceRegistry registry(std::move(adapter));
  const auto initial = registry.enumerate();
  const std::string window_id = initial.sources[1].id;
  EnumerationOptions monitors;
  monitors.kind = EnumerationOptions::Kind::Monitor;
  require(registry.enumerate(monitors).sources.size() == 1,
          "monitor filter returned another source kind");
  const auto restored = registry.enumerate();
  require(restored.sources[1].id == window_id,
          "kind filter retired an unobserved live source");
}

void explicitWindowStateSurvivesPublicBoundary() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto window = candidate(SourceKind::Window, "window-state", "Hidden window");
  window.label = "fixture.exe";
  window.flags.visible = false;
  window.flags.minimized = true;
  window.flags.own_process = true;
  window.availability = SourceAvailability::Available;
  window.capture_support = CaptureSupport::Unknown;
  window.exclusions = {ExclusionReason::NotVisible, ExclusionReason::OwnProcess};
  adapter->candidates = {window};
  SourceRegistry registry(std::move(adapter));
  const auto result = registry.enumerate();
  require(result.sources[0].label == "fixture.exe" &&
              result.sources[0].label != result.sources[0].title &&
              !result.sources[0].flags.visible &&
              result.sources[0].flags.minimized &&
              result.sources[0].flags.own_process &&
              result.sources[0].availability == SourceAvailability::Available &&
              result.sources[0].capture_support == CaptureSupport::Unknown &&
              result.sources[0].exclusions.size() == 2,
          "explicit window selection state changed at the public boundary");
}

void valuesAndCountsAreBounded() {
  auto adapter = std::make_unique<FakeEnumerator>();
  for (std::size_t index = 0; index < kMaximumWindows + 5; ++index) {
    auto value = candidate(SourceKind::Window, "window-" + std::to_string(index),
                           std::string(kMaximumSourceTextBytes + 20, 'x'));
    value.label.assign(kMaximumSourceTextBytes + 20, 'p');
    adapter->candidates.push_back(std::move(value));
  }
  SourceRegistry registry(std::move(adapter));
  const auto result = registry.enumerate();
  require(result.sources.size() == kMaximumWindows && result.windows_truncated,
          "window limit was not enforced");
  require(result.sources[0].title.size() == kMaximumSourceTextBytes &&
              result.sources[0].label.size() == kMaximumSourceTextBytes,
          "source string limits were not enforced");

  auto utf8_adapter = std::make_unique<FakeEnumerator>();
  auto split = candidate(SourceKind::Window, "utf8", std::string(255, 'a') +
                                                       "\xe2\x82\xac");
  utf8_adapter->candidates.push_back(std::move(split));
  SourceRegistry utf8_registry(std::move(utf8_adapter));
  const auto utf8_result = utf8_registry.enumerate();
  require(utf8_result.sources[0].title.size() == 255,
          "UTF-8 bound retained a partial code point");

  auto invalid_adapter = std::make_unique<FakeEnumerator>();
  std::string invalid = "A";
  invalid.push_back(static_cast<char>(0x80));
  invalid += "B";
  invalid.push_back(static_cast<char>(0xc0));
  invalid.push_back(static_cast<char>(0xaf));
  invalid.push_back(static_cast<char>(0xed));
  invalid.push_back(static_cast<char>(0xa0));
  invalid.push_back(static_cast<char>(0x80));
  invalid_adapter->candidates.push_back(
      candidate(SourceKind::Window, "invalid-utf8", invalid));
  SourceRegistry invalid_registry(std::move(invalid_adapter));
  const auto sanitized = invalid_registry.enumerate().sources[0].title;
  const std::string replacement = "\xef\xbf\xbd";
  require(sanitized == "A" + replacement + "B" + replacement + replacement +
                           replacement + replacement + replacement,
          "invalid UTF-8 scalar encodings escaped the public snapshot");
}

void diagnosticsExclusionsAndTombstonesAreBounded() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  auto value = candidate(SourceKind::Window, "bounded-state", "Window");
  value.exclusions.assign(kMaximumSourceExclusions + 5,
                          ExclusionReason::NotVisible);
  fake->candidates = {value};
  fake->diagnostics.assign(kMaximumEnumerationDiagnostics + 5,
                           {"bounded", "diagnostic"});
  fake->diagnostics[0].code = std::string(kMaximumSourceTextBytes + 20, 'c');
  fake->diagnostics[0].detail = std::string(kMaximumSourceTextBytes, 'd') +
                                std::string(1, static_cast<char>(0x80));
  SourceRegistry registry(std::move(adapter));
  const auto bounded = registry.enumerate();
  require(bounded.diagnostics.size() == kMaximumEnumerationDiagnostics &&
              bounded.diagnostics[0].code.size() == kMaximumSourceTextBytes &&
              bounded.diagnostics[0].detail.size() <= kMaximumSourceTextBytes &&
              bounded.diagnostics[0].detail.find(static_cast<char>(0x80)) ==
                  std::string::npos &&
              bounded.sources[0].exclusions.size() == kMaximumSourceExclusions,
          "diagnostic or exclusion state exceeded its public hard limit");

  std::string oldest;
  std::string newest;
  for (std::size_t index = 0; index < kMaximumRemovedTombstones + 1; ++index) {
    fake->diagnostics.clear();
    fake->candidates = {candidate(SourceKind::Window,
                                  "removed-" + std::to_string(index), "Window")};
    const auto active = registry.enumerate();
    const auto id = active.sources[0].id;
    if (index == 0) oldest = id;
    newest = id;
    fake->candidates.clear();
    registry.enumerate();
  }
  require(registry.resolve(oldest).status == ResolveStatus::Unknown &&
              registry.resolve(newest).status == ResolveStatus::Removed,
          "removed tombstone retention was not bounded FIFO state");
}

void failedBatchesIssueNoIdsAndPreservePriorState() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  fake->windows = EnumerationCompleteness::Failed;
  SourceRegistry registry(std::move(adapter));
  const auto first = registry.enumerate();
  require(!first.ok && first.sources.empty() && first.added_ids.empty(),
          "failed first batch issued a potentially unstable window ID");

  fake->windows = EnumerationCompleteness::Complete;
  fake->candidates = {candidate(SourceKind::Window, "stable", "Window")};
  const auto stable = registry.enumerate();
  const auto id = stable.sources[0].id;
  fake->windows = EnumerationCompleteness::Failed;
  fake->candidates.clear();
  const auto failed = registry.enumerate();
  require(!failed.ok && failed.removed.empty(),
          "failed reconciliation retired prior state");
  fake->windows = EnumerationCompleteness::Complete;
  fake->candidates = {candidate(SourceKind::Window, "stable", "Window")};
  require(registry.enumerate().sources[0].id == id,
          "failed reconciliation replaced a prior stable ID");
}

void transientMonitorIdentityFailurePreservesCanonicalId() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  fake->candidates = {candidate(SourceKind::Monitor, "monitor-path", "Display")};
  SourceRegistry registry(std::move(adapter));
  const auto id = registry.enumerate().sources[0].id;
  fake->monitors = EnumerationCompleteness::Failed;
  fake->candidates.clear();
  require(!registry.enumerate().ok,
          "transient monitor identity failure was reported as complete");
  fake->monitors = EnumerationCompleteness::Complete;
  fake->candidates = {candidate(SourceKind::Monitor, "monitor-path", "Display")};
  require(registry.enumerate().sources[0].id == id,
          "transient topology failure switched the live monitor namespace");
}

void monitorPathAvailabilityDoesNotDefineIdentity() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  auto monitor = candidate(SourceKind::Monitor,
                           "monitor-target:adapter-7:target-2", "Display");
  monitor.label = "path unavailable";
  fake->candidates = {monitor};
  SourceRegistry registry(std::move(adapter));
  const auto id = registry.enumerate().sources[0].id;
  fake->candidates[0].label = "path now available";
  const auto updated = registry.enumerate();
  require(updated.sources[0].id == id &&
              updated.sources[0].label == "path now available",
          "optional monitor path metadata changed the canonical target identity");
}

void partialIdentityCapacityFailsWithoutRotatingLiveIds() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  fake->windows_truncated = true;
  const auto fill = [&](std::size_t first) {
    fake->candidates.clear();
    for (std::size_t index = first; index < first + kMaximumWindows; ++index) {
      fake->candidates.push_back(candidate(
          SourceKind::Window, "capacity-" + std::to_string(index), "Window"));
    }
  };
  fill(0);
  SourceRegistry registry(std::move(adapter));
  const auto original_id = registry.enumerate().sources[0].id;
  fill(kMaximumWindows);
  require(registry.enumerate().sources.size() == kMaximumWindows,
          "bounded partial state could not retain its second page");
  fill(kMaximumWindows * 2);
  const auto overflow = registry.enumerate();
  require(!overflow.ok && overflow.sources.empty() &&
              std::any_of(overflow.diagnostics.begin(), overflow.diagnostics.end(),
                          [](const EnumerationDiagnostic& diagnostic) {
                            return diagnostic.code ==
                                   "source_registry_capacity_exceeded";
                          }),
          "identity capacity exhaustion was not terminal and typed");
  fill(0);
  require(registry.enumerate().sources[0].id == original_id,
          "capacity failure rotated an already issued live ID");
}

class BlockingEnumerator final : public SourceEnumerator {
 public:
  EnumerationBatch enumerate(const EnumerationOptions&) override {
    std::unique_lock lock(mutex);
    entered = true;
    changed.notify_all();
    changed.wait(lock, [this] { return released; });
    return {};
  }

  ResolveStatus validate(SourceKind, const std::string&) override {
    return ResolveStatus::Available;
  }

  void requestStop() noexcept override {
    {
      std::lock_guard lock(mutex);
      released = true;
    }
    changed.notify_all();
  }

  std::mutex mutex;
  std::condition_variable changed;
  bool entered = false;
  bool released = false;
};

void concurrentEnumerationIsRejectedWithoutQueuing() {
  auto adapter = std::make_unique<BlockingEnumerator>();
  auto* fake = adapter.get();
  SourceRegistry registry(std::move(adapter));
  std::thread active([&] { registry.enumerate(); });
  {
    std::unique_lock lock(fake->mutex);
    fake->changed.wait(lock, [&] { return fake->entered; });
  }
  const auto busy = registry.enumerate();
  require(busy.sources.empty() && busy.diagnostics.size() == 1 &&
              !busy.ok && !busy.complete &&
              busy.monitors == EnumerationCompleteness::Partial &&
              busy.windows == EnumerationCompleteness::Partial &&
              busy.diagnostics[0].code == "enumeration_in_progress",
          "concurrent enumeration was queued or untyped");
  {
    std::lock_guard lock(fake->mutex);
    fake->released = true;
  }
  fake->changed.notify_all();
  active.join();
}

void ownerShutdownCancelsAnActiveEnumeration() {
  auto adapter = std::make_unique<BlockingEnumerator>();
  auto* fake = adapter.get();
  SourceRegistry registry(std::move(adapter));
  SourceEnumeration active;
  std::thread worker([&] { active = registry.enumerate(); });
  {
    std::unique_lock lock(fake->mutex);
    fake->changed.wait(lock, [&] { return fake->entered; });
  }
  registry.shutdown();
  worker.join();
  require(!active.ok && !active.complete && active.sources.empty() &&
              !active.diagnostics.empty() &&
              active.diagnostics[0].code == "source_registry_stopped",
          "owner shutdown did not cancel active reconciliation without mutation");
  require(!registry.enumerate().ok,
          "stopped registry accepted another enumeration");
}

void stoppedResolveNeverCallsTheAdapter() {
  auto adapter = std::make_unique<FakeEnumerator>();
  auto* fake = adapter.get();
  fake->candidates = {candidate(SourceKind::Window, "stopped-resolve", "Window")};
  SourceRegistry registry(std::move(adapter));
  const auto id = registry.enumerate().sources[0].id;
  registry.shutdown();
  require(registry.resolve(id).status == ResolveStatus::Failed &&
              fake->validation_calls == 0,
          "stopped registry performed platform validation during resolve");
}

}  // namespace

int main() try {
  stableIdentitySurvivesMetadataChanges();
  removedIdentityIsNeverRemapped();
  duplicatePlatformIdentityIsOmitted();
  monitorLabelsDoNotDefineIdentity();
  monitorMetadataUpdatesWithoutReplacingIdentity();
  kindFiltersDoNotRetireUnobservedLiveSources();
  explicitWindowStateSurvivesPublicBoundary();
  valuesAndCountsAreBounded();
  diagnosticsExclusionsAndTombstonesAreBounded();
  failedBatchesIssueNoIdsAndPreservePriorState();
  transientMonitorIdentityFailurePreservesCanonicalId();
  monitorPathAvailabilityDoesNotDefineIdentity();
  partialIdentityCapacityFailsWithoutRotatingLiveIds();
  concurrentEnumerationIsRejectedWithoutQueuing();
  ownerShutdownCancelsAnActiveEnumeration();
  stoppedResolveNeverCallsTheAdapter();
  partialEnumerationPreservesIdentityAndSuppressesRemoval();
  completeRemovalIsTypedAndResolvable();
  truncatedOrderChurnPreservesIssuedIds();
  ownProcessFilterCannotRetainClosedEntries();
  sameHandleNewLifetimeGetsNewOpaqueId();
  std::cout << "source-registry:ok\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
