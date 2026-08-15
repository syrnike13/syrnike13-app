#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "../common/runtime_types.hpp"
#include "display_source_enumeration.hpp"

namespace syrnike::desktop_native::media {

class DisplaySourceService {
 public:
  bool beginEnumeration(std::string enumeration_id);
  void cancelEnumeration(std::string_view enumeration_id);
  void shutdown();

  std::vector<DisplaySourceInfo> metadataPage(
      std::string_view enumeration_id,
      std::uint64_t page,
      std::uint64_t excluded_window_handle);
  std::vector<DisplaySourceInfo> visual(
      std::string_view enumeration_id,
      std::string_view source_id,
      std::uint64_t excluded_window_handle);

 private:
  DisplaySourceEnumerationFence fence_;
};

}  // namespace syrnike::desktop_native::media
