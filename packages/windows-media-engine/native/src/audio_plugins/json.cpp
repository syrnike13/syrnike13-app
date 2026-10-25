#include "audio_plugins/json.hpp"

#include <charconv>
#include <cmath>
#include <cstdio>

namespace syrnike::windows_media::audio_plugins {
namespace {
constexpr int kMaximumDepth = 16;
class Parser {
 public:
  explicit Parser(std::string_view text) : text_(text) {}
  std::optional<Json> document() {
    auto value = parseValue(0);
    skipSpace();
    if (!value || position_ != text_.size()) return std::nullopt;
    return value;
  }
 private:
  void skipSpace() {
    while (position_ < text_.size() &&
           (text_[position_] == ' ' || text_[position_] == '\t' || text_[position_] == '\r' || text_[position_] == '\n'))
      ++position_;
  }
  bool consume(std::string_view token) {
    if (text_.substr(position_, token.size()) != token) return false;
    position_ += token.size();
    return true;
  }
  std::optional<Json> parseValue(int depth) {
    if (depth > kMaximumDepth) return std::nullopt;
    skipSpace();
    if (position_ >= text_.size()) return std::nullopt;
    const char next = text_[position_];
    if (next == '{') return parseObject(depth);
    if (next == '[') return parseArray(depth);
    if (next == '"') {
      auto value = parseString();
      if (!value) return std::nullopt;
      return Json(std::move(*value));
    }
    if (consume("true")) return Json(true);
    if (consume("false")) return Json(false);
    if (consume("null")) return Json(nullptr);
    double number = 0;
    const auto* begin = text_.data() + position_;
    const auto result = std::from_chars(begin, text_.data() + text_.size(), number);
    if (result.ec != std::errc{} || !std::isfinite(number)) return std::nullopt;
    position_ += static_cast<std::size_t>(result.ptr - begin);
    return Json(number);
  }
  std::optional<Json> parseArray(int depth) {
    ++position_;
    Json::Array values;
    skipSpace();
    if (consume("]")) return Json(std::move(values));
    for (;;) {
      auto value = parseValue(depth + 1);
      if (!value) return std::nullopt;
      values.push_back(std::move(*value));
      skipSpace();
      if (consume("]")) return Json(std::move(values));
      if (!consume(",")) return std::nullopt;
    }
  }
  std::optional<Json> parseObject(int depth) {
    ++position_;
    Json::Object values;
    skipSpace();
    if (consume("}")) return Json(std::move(values));
    for (;;) {
      skipSpace();
      auto key = parseString();
      if (!key) return std::nullopt;
      skipSpace();
      if (!consume(":")) return std::nullopt;
      auto value = parseValue(depth + 1);
      if (!value) return std::nullopt;
      values.insert_or_assign(std::move(*key), std::move(*value));
      skipSpace();
      if (consume("}")) return Json(std::move(values));
      if (!consume(",")) return std::nullopt;
    }
  }
  static void appendUtf8(std::string& out, std::uint32_t code) {
    if (code < 0x80) {
      out += static_cast<char>(code);
    } else if (code < 0x800) {
      out += static_cast<char>(0xC0 | (code >> 6));
      out += static_cast<char>(0x80 | (code & 0x3F));
    } else if (code < 0x10000) {
      out += static_cast<char>(0xE0 | (code >> 12));
      out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (code & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (code >> 18));
      out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (code & 0x3F));
    }
  }
  std::optional<std::uint32_t> hex4() {
    if (position_ + 4 > text_.size()) return std::nullopt;
    std::uint32_t code = 0;
    const auto result = std::from_chars(text_.data() + position_, text_.data() + position_ + 4, code, 16);
    if (result.ec != std::errc{} || result.ptr != text_.data() + position_ + 4) return std::nullopt;
    position_ += 4;
    return code;
  }
  std::optional<std::string> parseString() {
    if (!consume("\"")) return std::nullopt;
    std::string out;
    while (position_ < text_.size()) {
      const char next = text_[position_++];
      if (next == '"') return out;
      if (static_cast<unsigned char>(next) < 0x20) return std::nullopt;
      if (next != '\\') {
        out += next;
        continue;
      }
      if (position_ >= text_.size()) return std::nullopt;
      const char escape = text_[position_++];
      switch (escape) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          auto code = hex4();
          if (!code) return std::nullopt;
          if (*code >= 0xD800 && *code < 0xDC00) {
            if (!consume("\\u")) return std::nullopt;
            const auto low = hex4();
            if (!low || *low < 0xDC00 || *low >= 0xE000) return std::nullopt;
            *code = 0x10000 + ((*code - 0xD800) << 10) + (*low - 0xDC00);
          }
          appendUtf8(out, *code);
          break;
        }
        default: return std::nullopt;
      }
    }
    return std::nullopt;
  }
  std::string_view text_;
  std::size_t position_ = 0;
};
void dumpString(std::string& out, const std::string& value) {
  out += '"';
  for (const char next : value) {
    switch (next) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(next) < 0x20) {
          char escaped[8];
          std::snprintf(escaped, sizeof(escaped), "\\u%04x", static_cast<unsigned>(next));
          out += escaped;
        } else {
          out += next;
        }
    }
  }
  out += '"';
}
const Json kNull;
}  // namespace

std::optional<Json> Json::parse(std::string_view text) { return Parser(text).document(); }
std::optional<double> Json::number() const noexcept {
  if (const auto* value = std::get_if<double>(&value_)) return *value;
  return std::nullopt;
}
std::optional<bool> Json::boolean() const noexcept {
  if (const auto* value = std::get_if<bool>(&value_)) return *value;
  return std::nullopt;
}
const Json::Array* Json::array() const noexcept {
  if (const auto* value = std::get_if<std::shared_ptr<Array>>(&value_)) return value->get();
  return nullptr;
}
const Json::Object* Json::object() const noexcept {
  if (const auto* value = std::get_if<std::shared_ptr<Object>>(&value_)) return value->get();
  return nullptr;
}
const Json& Json::operator[](std::string_view key) const noexcept {
  const auto* members = object();
  if (!members) return kNull;
  const auto found = members->find(key);
  return found == members->end() ? kNull : found->second;
}
std::string Json::dump() const {
  std::string out;
  std::visit([&](const auto& value) {
    using Value = std::decay_t<decltype(value)>;
    if constexpr (std::is_same_v<Value, std::monostate>) {
      out += "null";
    } else if constexpr (std::is_same_v<Value, bool>) {
      out += value ? "true" : "false";
    } else if constexpr (std::is_same_v<Value, double>) {
      char text[32];
      const auto result = std::to_chars(text, text + sizeof(text), std::isfinite(value) ? value : 0.0);
      out.append(text, result.ptr);
    } else if constexpr (std::is_same_v<Value, std::string>) {
      dumpString(out, value);
    } else if constexpr (std::is_same_v<Value, std::shared_ptr<Array>>) {
      out += '[';
      for (std::size_t index = 0; index < value->size(); ++index) {
        if (index) out += ',';
        out += (*value)[index].dump();
      }
      out += ']';
    } else {
      out += '{';
      bool first = true;
      for (const auto& [key, member] : *value) {
        if (!first) out += ',';
        first = false;
        dumpString(out, key);
        out += ':';
        out += member.dump();
      }
      out += '}';
    }
  }, value_);
  return out;
}
}  // namespace syrnike::windows_media::audio_plugins
