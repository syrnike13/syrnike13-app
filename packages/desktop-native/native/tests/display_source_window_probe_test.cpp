#include <chrono>
#include <cstddef>
#include <iostream>
#include <stdexcept>
#include <string>

#include <windows.h>

#include "media/display_source_enumeration.hpp"
#include "media/display_source_window_probe.hpp"

int main() try {
  using namespace std::chrono_literals;
  using syrnike::desktop_native::media::DisplaySourceEnumerationFence;
  using syrnike::desktop_native::media::DisplaySourceMetadataPage;
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

  std::cout << "display source paging, fence, filter, and probe tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
