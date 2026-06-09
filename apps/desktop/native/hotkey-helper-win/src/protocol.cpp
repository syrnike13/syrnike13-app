#include "protocol.hpp"

namespace syrnike::hotkeys {

std::string jsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (unsigned char ch : value) {
    switch (ch) {
      case '\\':
      case '"':
        out.push_back('\\');
        out.push_back(static_cast<char>(ch));
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (ch < 0x20) {
          constexpr char hex[] = "0123456789abcdef";
          out += "\\u00";
          out.push_back(hex[ch >> 4]);
          out.push_back(hex[ch & 0x0f]);
        } else {
          out.push_back(static_cast<char>(ch));
        }
    }
  }
  return out;
}

std::string eventToJson(const NativeInputEvent& event) {
  std::string json =
    "{\"type\":\"" + jsonEscape(event.type) +
    "\",\"source\":\"" + jsonEscape(event.source) +
    "\",\"code\":\"" + jsonEscape(event.code) +
    "\",\"label\":\"" + jsonEscape(event.label) +
    "\",\"pressedCodes\":[";

  for (std::size_t index = 0; index < event.pressed_codes.size(); ++index) {
    if (index > 0) json += ",";
    json += "\"" + jsonEscape(event.pressed_codes[index]) + "\"";
  }

  json += "]}";
  return json;
}

}  // namespace syrnike::hotkeys
