#pragma once

#include <cstdint>
#include <initializer_list>
#include <string>
#include <string_view>
#include <variant>

namespace syrnike::desktop_native::diagnostics {

struct DiagnosticField {
  using Value = std::variant<
    std::monostate,
    bool,
    std::int64_t,
    std::uint64_t,
    double,
    std::string
  >;

  std::string_view key;
  Value value;

  DiagnosticField(std::string_view key_in, const char* value_in)
    : key(key_in), value(value_in ? std::string(value_in) : std::string()) {}
  DiagnosticField(std::string_view key_in, std::string_view value_in)
    : key(key_in), value(std::string(value_in)) {}
  DiagnosticField(std::string_view key_in, std::string value_in)
    : key(key_in), value(std::move(value_in)) {}
  DiagnosticField(std::string_view key_in, bool value_in) : key(key_in), value(value_in) {}
  DiagnosticField(std::string_view key_in, std::int64_t value_in) : key(key_in), value(value_in) {}
  DiagnosticField(std::string_view key_in, std::uint64_t value_in) : key(key_in), value(value_in) {}
  DiagnosticField(std::string_view key_in, double value_in) : key(key_in), value(value_in) {}
  DiagnosticField(std::string_view key_in) : key(key_in), value(std::monostate{}) {}
};

std::string redactForDiagnostics(std::string_view value) noexcept;

class DiagnosticLog final {
 public:
  static DiagnosticLog& instance() noexcept;

  void initializeForMediaProcess() noexcept;
  void shutdown() noexcept;

  [[nodiscard]] bool enabled() const noexcept;
  [[nodiscard]] std::string runId() const noexcept;
  [[nodiscard]] std::uint64_t steadyNowMs() const noexcept;

  void write(
    std::string_view event,
    std::initializer_list<DiagnosticField> fields = {}
  ) noexcept;

 private:
  DiagnosticLog() = default;
  ~DiagnosticLog() = default;
  DiagnosticLog(const DiagnosticLog&) = delete;
  DiagnosticLog& operator=(const DiagnosticLog&) = delete;
};

}  // namespace syrnike::desktop_native::diagnostics
