#include "sources/utf8.hpp"

namespace syrnike::windows_media::sources {
namespace {

constexpr char kReplacement[] = "\xef\xbf\xbd";

bool continuation(unsigned char value) {
  return (value & 0xc0U) == 0x80U;
}

bool appendReplacement(std::string& output, std::size_t limit) {
  if (output.size() + 3 > limit) return false;
  output.append(kReplacement, 3);
  return true;
}

}  // namespace

std::string sanitizeBoundedUtf8(std::string value, std::size_t limit) {
  std::string output;
  output.reserve(value.size() < limit ? value.size() : limit);
  for (std::size_t index = 0; index < value.size();) {
    const auto lead = static_cast<unsigned char>(value[index]);
    if (lead <= 0x7fU) {
      if (output.size() == limit) break;
      output.push_back(static_cast<char>(lead));
      ++index;
      continue;
    }
    std::size_t width = 0;
    if (lead >= 0xc2U && lead <= 0xdfU) width = 2;
    else if (lead >= 0xe0U && lead <= 0xefU) width = 3;
    else if (lead >= 0xf0U && lead <= 0xf4U) width = 4;
    bool valid = width != 0 && index + width <= value.size();
    for (std::size_t offset = 1; valid && offset < width; ++offset) {
      valid = continuation(static_cast<unsigned char>(value[index + offset]));
    }
    if (valid && width == 3) {
      const auto second = static_cast<unsigned char>(value[index + 1]);
      valid = !((lead == 0xe0U && second < 0xa0U) ||
                (lead == 0xedU && second > 0x9fU));
    }
    if (valid && width == 4) {
      const auto second = static_cast<unsigned char>(value[index + 1]);
      valid = !((lead == 0xf0U && second < 0x90U) ||
                (lead == 0xf4U && second > 0x8fU));
    }
    if (!valid) {
      if (!appendReplacement(output, limit)) break;
      ++index;
      continue;
    }
    if (output.size() + width > limit) break;
    output.append(value, index, width);
    index += width;
  }
  return output;
}

}  // namespace syrnike::windows_media::sources
