#pragma once

#include <functional>
#include <memory>
#include <string>

#include "sources/source_registry.hpp"

namespace syrnike::windows_media::sources {

struct Win32SourceEnumeratorTestHooks {
  std::function<void()> before_post_barrier;
  std::function<void()> before_final_barrier;
  std::function<void()> on_cancel;
  std::function<void(const std::string&)> after_window_observed;
  std::function<bool(const std::string&)> include_window_title;
  std::function<void()> before_monitor_post_validation;
  std::function<std::uint64_t()> monitor_topology_generation;
  std::size_t maximum_tracked_windows = kMaximumTrackedWindows;
  bool force_windows_truncated = false;
};

std::unique_ptr<SourceEnumerator> createWin32SourceEnumerator(
    Win32SourceEnumeratorTestHooks test_hooks = {});

}  // namespace syrnike::windows_media::sources
