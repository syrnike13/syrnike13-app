#include <algorithm>
#include <stdexcept>
#include <string_view>

#include "windows_process_resource_snapshot.hpp"

int main() try {
  using namespace syrnike::desktop_native::tests;

  const auto delta = resourceTypeDelta(
      {{"audio_worker", 2}, {"room.dll", 1}},
      {{"audio_worker", 5}, {"room.dll", 1}, {"video_worker", 3}},
      64);
  if (delta.size() != 2 || delta[0].category != "audio_worker" ||
      delta[0].count != 3 || delta[1].category != "video_worker" ||
      delta[1].count != 3) {
    throw std::runtime_error("resource type delta did not retain positive growth");
  }

  ResourceTypeCounts many;
  for (std::size_t index = 0; index < 80; ++index) {
    many.push_back({"type_" + std::to_string(index), index + 1});
  }
  if (resourceTypeDelta({}, many, 64).size() != 64) {
    throw std::runtime_error("resource type delta exceeded its output bound");
  }

  const auto live = captureWindowsProcessResourceTypes();
  if (live.threads.empty() || live.handles.empty() ||
      live.threads.size() > 64 || live.handles.size() > 64) {
    throw std::runtime_error("live resource snapshot was empty or unbounded");
  }
  const auto safe = [](const ResourceTypeCount& value) {
    return !value.category.empty() && value.category.size() <= 64 &&
        std::all_of(value.category.begin(), value.category.end(), [](char ch) {
          return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
              (ch >= '0' && ch <= '9') || ch == '_' || ch == '.' ||
              ch == '-' || ch == '@';
        });
  };
  if (!std::all_of(live.threads.begin(), live.threads.end(), safe) ||
      !std::all_of(live.handles.begin(), live.handles.end(), safe)) {
    throw std::runtime_error("resource snapshot exposed an unsafe category");
  }
  return 0;
} catch (const std::exception&) {
  return 1;
}
