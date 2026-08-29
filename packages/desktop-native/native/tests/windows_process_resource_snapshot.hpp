#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace syrnike::desktop_native::tests {

struct ResourceTypeCount {
  std::string category;
  std::size_t count = 0;
};

using ResourceTypeCounts = std::vector<ResourceTypeCount>;

struct WindowsProcessResourceTypes {
  ResourceTypeCounts threads;
  ResourceTypeCounts handles;
};

[[nodiscard]] ResourceTypeCounts resourceTypeDelta(
    const ResourceTypeCounts& baseline,
    const ResourceTypeCounts& observed,
    std::size_t maximum_types);

[[nodiscard]] WindowsProcessResourceTypes
captureWindowsProcessResourceTypes() noexcept;

}  // namespace syrnike::desktop_native::tests
