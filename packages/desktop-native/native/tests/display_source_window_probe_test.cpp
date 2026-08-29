#include <atomic>
#include <chrono>
#include <cstddef>
#include <future>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

#include <windows.h>

#include "media/display_source_enumeration.hpp"
#include "media/display_source_visual_probe.hpp"
#include "media/display_source_window_probe.hpp"

int main() try {
  using namespace std::chrono_literals;
  using syrnike::desktop_native::media::DisplaySourceEnumerationFence;
  using syrnike::desktop_native::media::DisplaySourceMetadataPage;
  using syrnike::desktop_native::media::DisplaySourceVisualProbeAdmission;
  using syrnike::desktop_native::media::DisplaySourceVisualProbeAttempt;
  using syrnike::desktop_native::media::DisplayWindowProbeFacts;
  using syrnike::desktop_native::media::WindowMessageIconResult;
  using syrnike::desktop_native::media::kDisplaySourceMetadataPageSize;
  using syrnike::desktop_native::media::queryWindowMessageIcon;
  using syrnike::desktop_native::media::shouldIncludeDisplayWindow;

  constexpr std::size_t synthetic_source_count = 500;
  std::size_t page_zero_scanned = 0;
  std::size_t page_zero_allocations = 0;
  DisplaySourceMetadataPage<std::string> page_zero(0);
  for (std::size_t index = 0; index < synthetic_source_count; ++index) {
    ++page_zero_scanned;
    if (!page_zero.visit([&] {
          ++page_zero_allocations;
          return std::to_string(index);
        })) {
      break;
    }
  }
  if (page_zero_scanned != kDisplaySourceMetadataPageSize + 1 ||
      page_zero_allocations != kDisplaySourceMetadataPageSize + 1 ||
      page_zero.items().size() != kDisplaySourceMetadataPageSize + 1 ||
      !page_zero.hasNextPage()) {
    throw std::runtime_error(
        "500-source enumeration exceeded the fixed metadata page budget");
  }

  std::size_t later_page_scanned = 0;
  std::size_t later_page_allocations = 0;
  DisplaySourceMetadataPage<std::string> later_page(10);
  for (std::size_t index = 0; index < synthetic_source_count; ++index) {
    ++later_page_scanned;
    if (!later_page.visit([&] {
          ++later_page_allocations;
          return std::to_string(index);
        })) {
      break;
    }
  }
  if (later_page_scanned != 10 * kDisplaySourceMetadataPageSize +
          kDisplaySourceMetadataPageSize + 1 ||
      later_page_allocations != kDisplaySourceMetadataPageSize + 1 ||
      !later_page.hasNextPage()) {
    throw std::runtime_error(
        "later metadata pages retained skipped synthetic sources");
  }

  DisplaySourceEnumerationFence fence;
  if (!fence.begin("old") || !fence.isCurrent("old")) {
    throw std::runtime_error("display-source enumeration did not start");
  }
  if (!fence.begin("new") || fence.isCurrent("old") ||
      !fence.isCurrent("new")) {
    throw std::runtime_error("new enumeration accepted a stale result");
  }
  fence.cancel("old");
  if (!fence.isCurrent("new")) {
    throw std::runtime_error("stale cancellation stopped the current enumeration");
  }
  fence.cancel("new");
  if (fence.isCurrent("new")) {
    throw std::runtime_error("current enumeration ignored cancellation");
  }
  for (std::size_t index = 0; index < 100; ++index) {
    const auto id = std::to_string(index);
    if (!fence.begin(id) || !fence.isCurrent(id)) {
      throw std::runtime_error("repeated display-source restart lost its fence");
    }
    fence.cancel(id);
  }
  fence.shutdown();
  if (fence.begin("after-shutdown") || fence.isCurrent("after-shutdown")) {
    throw std::runtime_error("display-source enumeration restarted after shutdown");
  }

  const DisplayWindowProbeFacts visible_window{
      true, true, false, false, false, false, true, 800, 600, true};
  if (!shouldIncludeDisplayWindow(visible_window)) {
    throw std::runtime_error("visible synthetic window was filtered out");
  }
  auto hidden_window = visible_window;
  hidden_window.visible = false;
  auto cloaked_window = visible_window;
  cloaked_window.cloaked = true;
  auto tool_window = visible_window;
  tool_window.tool_window = true;
  auto no_activate_window = visible_window;
  no_activate_window.no_activate = true;
  auto small_window = visible_window;
  small_window.width = 79;
  auto untitled_window = visible_window;
  untitled_window.has_title = false;
  if (shouldIncludeDisplayWindow(hidden_window) ||
      shouldIncludeDisplayWindow(cloaked_window) ||
      shouldIncludeDisplayWindow(tool_window) ||
      shouldIncludeDisplayWindow(no_activate_window) ||
      shouldIncludeDisplayWindow(small_window) ||
      shouldIncludeDisplayWindow(untitled_window)) {
    throw std::runtime_error("hidden synthetic window entered a metadata page");
  }

  constexpr std::size_t synthetic_windows = 30;
  auto virtual_elapsed = 0ms;
  std::size_t calls = 0;
  const auto wall_started = std::chrono::steady_clock::now();
  for (std::size_t index = 0; index < synthetic_windows; ++index) {
    const auto icon = queryWindowMessageIcon(
        [&](std::uintptr_t, std::chrono::milliseconds timeout) {
          ++calls;
          virtual_elapsed += timeout;
          return WindowMessageIconResult{false, 0};
        });
    if (icon != 0) {
      throw std::runtime_error("hung synthetic window returned an icon");
    }
  }
  const auto wall_elapsed = std::chrono::steady_clock::now() - wall_started;
  if (calls != synthetic_windows || virtual_elapsed != 300ms ||
      virtual_elapsed >= 500ms || wall_elapsed >= 500ms) {
    throw std::runtime_error(
        "30 hung windows exceeded the listDisplaySources icon budget");
  }

  syrnike::desktop_native::CleanupSupervisor probe_supervisor({2, 4});
  DisplaySourceVisualProbeAdmission probe_admission(2);
  const auto wait_for_probe_drain = [&] {
    const auto deadline = std::chrono::steady_clock::now() + 1s;
    while (probe_supervisor.snapshot().owned_jobs != 0 &&
           std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(1ms);
    }
    if (probe_supervisor.snapshot().owned_jobs != 0) {
      throw std::runtime_error("display visual probe ownership did not drain");
    }
  };
  const auto wait_for_owned_jobs = [&](std::size_t expected) {
    const auto deadline = std::chrono::steady_clock::now() + 1s;
    while (probe_supervisor.snapshot().owned_jobs != expected &&
           std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(1ms);
    }
    if (probe_supervisor.snapshot().owned_jobs != expected) {
      throw std::runtime_error("display visual probe ownership did not settle");
    }
  };

  {
    std::promise<void> first_entered_promise;
    auto first_entered = first_entered_promise.get_future();
    std::promise<void> first_release_promise;
    auto first_release = first_release_promise.get_future().share();
    std::atomic_bool current{true};
    auto blocked_attempt = DisplaySourceVisualProbeAttempt<int>::start(
        probe_supervisor,
        probe_admission,
        [&, first_release](
            const std::atomic_bool& cancelled) -> std::optional<int> {
          first_entered_promise.set_value();
          first_release.wait();
          return cancelled.load(std::memory_order_acquire)
              ? std::nullopt
              : std::optional<int>(7);
        });
    if (!blocked_attempt) {
      throw std::runtime_error(
          "display visual cancellation probe was rejected");
    }
    first_entered.wait();
    auto waiter = std::async(std::launch::async, [&] {
      return blocked_attempt->waitUntil(
          std::chrono::steady_clock::now() + 1s,
          [&] { return current.load(std::memory_order_acquire); });
    });
    const auto cancelled_at = std::chrono::steady_clock::now();
    current.store(false, std::memory_order_release);
    const auto result = waiter.get();
    if (result || std::chrono::steady_clock::now() - cancelled_at >= 100ms) {
      throw std::runtime_error(
          "stale display visual probe retained the native query lane");
    }

    const auto healthy_started = std::chrono::steady_clock::now();
    auto healthy_attempt = DisplaySourceVisualProbeAttempt<int>::start(
        probe_supervisor,
        probe_admission,
        [](const std::atomic_bool&) { return std::optional<int>(8); });
    const auto healthy_result = healthy_attempt
        ? healthy_attempt->waitUntil(
              healthy_started + 100ms, [] { return true; })
        : std::nullopt;
    if (!healthy_result || *healthy_result != 8 ||
        std::chrono::steady_clock::now() - healthy_started >= 100ms) {
      throw std::runtime_error(
          "one hung display visual probe stalled a healthy source");
    }
    wait_for_owned_jobs(1);

    std::promise<void> second_entered_promise;
    auto second_entered = second_entered_promise.get_future();
    std::promise<void> second_release_promise;
    auto second_release = second_release_promise.get_future().share();
    auto second_blocked_attempt = DisplaySourceVisualProbeAttempt<int>::start(
        probe_supervisor,
        probe_admission,
        [&, second_release](
            const std::atomic_bool& cancelled) -> std::optional<int> {
          second_entered_promise.set_value();
          second_release.wait();
          return cancelled.load(std::memory_order_acquire)
              ? std::nullopt
              : std::optional<int>(9);
        });
    if (!second_blocked_attempt) {
      throw std::runtime_error(
          "display visual probe did not use remaining worker capacity");
    }
    second_entered.wait();
    const auto blocked_snapshot = probe_supervisor.snapshot();
    for (std::size_t index = 0; index < 100; ++index) {
      const auto rejected = DisplaySourceVisualProbeAttempt<int>::start(
          probe_supervisor,
          probe_admission,
          [](const std::atomic_bool&) { return std::optional<int>(10); });
      if (rejected) {
        throw std::runtime_error(
            "saturated display visual executor admitted a queued probe");
      }
    }
    const auto rejected_snapshot = probe_supervisor.snapshot();
    if (rejected_snapshot.owned_jobs != blocked_snapshot.owned_jobs ||
        rejected_snapshot.backlog_jobs != blocked_snapshot.backlog_jobs ||
        rejected_snapshot.owned_jobs != 2 ||
        rejected_snapshot.backlog_jobs != 0) {
      throw std::runtime_error(
          "rejected display visual probes accumulated ownership");
    }
    first_release_promise.set_value();
    second_release_promise.set_value();
    wait_for_probe_drain();
  }

  {
    std::promise<void> release_promise;
    auto release = release_promise.get_future().share();
    auto attempt = DisplaySourceVisualProbeAttempt<int>::start(
        probe_supervisor,
        probe_admission,
        [release](const std::atomic_bool& cancelled) -> std::optional<int> {
          release.wait();
          return cancelled.load(std::memory_order_acquire)
              ? std::nullopt
              : std::optional<int>(9);
        });
    if (!attempt) {
      throw std::runtime_error("display visual deadline probe was rejected");
    }
    const auto started = std::chrono::steady_clock::now();
    const auto result = attempt->waitUntil(
        started + 25ms, [] { return true; });
    if (result || std::chrono::steady_clock::now() - started >= 100ms) {
      throw std::runtime_error(
          "hung display visual probe exceeded its response deadline");
    }
    release_promise.set_value();
    wait_for_probe_drain();
  }

  std::cout << "display source paging, fence, filter, and probe tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
