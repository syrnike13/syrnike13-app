#pragma once

#include <cstddef>
#include <string>

namespace syrnike::windows_media::sources {

std::string sanitizeBoundedUtf8(std::string value, std::size_t limit);

}  // namespace syrnike::windows_media::sources
