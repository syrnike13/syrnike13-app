#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace syrnike::windows_media::audio_plugins {
// Small JSON value for the plugin host control channel: one object per line
// from Electron, bounded by the reader. Numbers are doubles.
class Json {
 public:
  using Array = std::vector<Json>;
  using Object = std::map<std::string, Json, std::less<>>;
  Json() = default;
  Json(std::nullptr_t) {}
  Json(bool value) : value_(value) {}
  Json(double value) : value_(value) {}
  Json(int value) : value_(static_cast<double>(value)) {}
  Json(std::uint32_t value) : value_(static_cast<double>(value)) {}
  Json(std::string value) : value_(std::move(value)) {}
  Json(const char* value) : value_(std::string(value)) {}
  Json(Array value) : value_(std::make_shared<Array>(std::move(value))) {}
  Json(Object value) : value_(std::make_shared<Object>(std::move(value))) {}

  static std::optional<Json> parse(std::string_view);
  std::string dump() const;

  bool isObject() const noexcept { return std::holds_alternative<std::shared_ptr<Object>>(value_); }
  const std::string* string() const noexcept { return std::get_if<std::string>(&value_); }
  std::optional<double> number() const noexcept;
  std::optional<bool> boolean() const noexcept;
  const Array* array() const noexcept;
  const Object* object() const noexcept;
  // Object member or null.
  const Json& operator[](std::string_view key) const noexcept;
 private:
  std::variant<std::monostate, bool, double, std::string, std::shared_ptr<Array>, std::shared_ptr<Object>> value_;
};
}  // namespace syrnike::windows_media::audio_plugins
