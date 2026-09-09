#pragma once

#include <string_view>

#if defined(WINDOWS_MEDIA_TEST_FAULT_GATES)
#include <windows.h>

#include <array>
#include <atomic>
#include <charconv>
#include <stdexcept>
#include <string>

namespace syrnike::windows_media::testing {
namespace detail {
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  explicit Handle(HANDLE handle) : value(handle) {}
};

struct FaultConfiguration {
  std::wstring directory;
  std::string point;
  unsigned call = 0;
};

inline FaultConfiguration readConfiguration() {
  std::array<wchar_t, 32768> root{};
  const auto length = GetEnvironmentVariableW(L"SYRNIKE_MEDIA_ROOT", root.data(),
      static_cast<DWORD>(root.size()));
  if (!length) return {};
  if (length >= root.size()) throw std::runtime_error("test_fault_root_capacity");
  FaultConfiguration result;
  result.directory.assign(root.data(), length);
  const auto path = result.directory + L"\\native-test-fault.txt";
  Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) {
    if (GetLastError() == ERROR_FILE_NOT_FOUND) return {};
    throw std::runtime_error("test_fault_configuration_open_failed");
  }
  std::array<char, 128> bytes{};
  DWORD read = 0;
  if (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) ||
      read == bytes.size()) throw std::runtime_error("test_fault_configuration_capacity");
  std::string_view text(bytes.data(), read);
  if (!text.empty() && text.back() == '\n') text.remove_suffix(1);
  const auto separator = text.find('\n');
  if (separator == std::string_view::npos || separator == 0 || separator > 64)
    throw std::runtime_error("test_fault_configuration_invalid");
  result.point.assign(text.substr(0, separator));
  if (result.point.find_first_not_of("abcdefghijklmnopqrstuvwxyz-") != std::string::npos)
    throw std::runtime_error("test_fault_point_invalid");
  const auto number = text.substr(separator + 1);
  const auto parsed = std::from_chars(number.data(), number.data() + number.size(), result.call);
  if (parsed.ec != std::errc{} || parsed.ptr != number.data() + number.size() ||
      result.call == 0 || result.call > 100000)
    throw std::runtime_error("test_fault_call_invalid");
  return result;
}
}  // namespace detail

// Test builds alone read this sidecar. Exactly one chosen call records entry,
// then behaves like a platform call that cannot be cancelled. No worker is
// spawned: the real owner remains held until the outer process boundary exits.
inline void holdProductFault(std::string_view point) {
  static const auto configuration = detail::readConfiguration();
  static std::atomic_uint calls{0};
  if (configuration.point != point ||
      calls.fetch_add(1, std::memory_order_relaxed) + 1 != configuration.call) return;
  detail::Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!event.value) throw std::runtime_error("test_fault_event_failed");
  const auto marker = configuration.directory + L"\\native-test-fault-held-" +
      std::to_wstring(GetCurrentProcessId()) + L".json";
  {
    detail::Handle file(CreateFileW(marker.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) throw std::runtime_error("test_fault_marker_open_failed");
    const auto record = "{\"point\":\"" + configuration.point + "\",\"call\":" +
        std::to_string(configuration.call) + ",\"pid\":" + std::to_string(GetCurrentProcessId()) + "}\n";
    DWORD written = 0;
    if (!WriteFile(file.value, record.data(), static_cast<DWORD>(record.size()), &written, nullptr) ||
        written != record.size() || !FlushFileBuffers(file.value))
      throw std::runtime_error("test_fault_marker_write_failed");
  }
  static_cast<void>(WaitForSingleObject(event.value, INFINITE));
  throw std::runtime_error("test_fault_hold_returned");
}
}  // namespace syrnike::windows_media::testing
#else
namespace syrnike::windows_media::testing {
inline void holdProductFault(std::string_view) noexcept {}
}  // namespace syrnike::windows_media::testing
#endif
