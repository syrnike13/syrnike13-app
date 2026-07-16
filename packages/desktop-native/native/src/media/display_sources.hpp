#pragma once

#include <cstdint>
#include <vector>

#include "../common/runtime_types.hpp"

namespace syrnike::desktop_native::media {

std::vector<DisplaySourceInfo> listDisplaySources(std::uint64_t excluded_window_handle);

}  // namespace syrnike::desktop_native::media
