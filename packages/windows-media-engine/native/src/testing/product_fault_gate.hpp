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

struct FaultSelection {
  std::string point;
  unsigned call = 0;
};

struct FaultConfiguration {
  std::wstring directory;
  std::array<FaultSelection, 2> selections;
  std::size_t count = 0;
};

inline FaultConfiguration readConfiguration() {
  std::array<wchar_t, 32768> root{};
  const auto length = GetEnvironmentVariableW(L"SYRNIKE_MEDIA_ROOT", root.data(),
      static_cast<DWORD>(root.size()));
  if (!length) return {};
  if (length >= root.size()) throw std::runtime_error("test_fault_root_capacity");
  FaultConfiguration result;
  result.directory.assign(root.data(), length);
  // The artifact directory intentionally permits only verified runtime files.
  // Test controls and entry markers live beside that directory, never inside it.
  result.directory += L"\\..";
  const auto path = result.directory + L"\\native-test-fault.txt";
  Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) {
    if (GetLastError() == ERROR_FILE_NOT_FOUND) return {};
    throw std::runtime_error("test_fault_configuration_open_failed");
  }
  std::array<char, 256> bytes{};
  DWORD read = 0;
  if (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) ||
      read == bytes.size()) throw std::runtime_error("test_fault_configuration_capacity");
  std::string_view text(bytes.data(), read);
  if (!text.empty() && text.back() == '\n') text.remove_suffix(1);
  while (!text.empty()) {
    if (result.count == result.selections.size()) throw std::runtime_error("test_fault_selection_capacity");
    auto& selection = result.selections[result.count++];
    const auto separator = text.find('\n');
    if (separator == std::string_view::npos || separator == 0 || separator > 64)
      throw std::runtime_error("test_fault_configuration_invalid");
    selection.point.assign(text.substr(0, separator));
    if (selection.point.find_first_not_of("abcdefghijklmnopqrstuvwxyz-") != std::string::npos)
      throw std::runtime_error("test_fault_point_invalid");
    text.remove_prefix(separator + 1);
    const auto next = text.find('\n');
    const auto number = text.substr(0, next);
    const auto parsed = std::from_chars(number.data(), number.data() + number.size(), selection.call);
    if (parsed.ec != std::errc{} || parsed.ptr != number.data() + number.size() ||
        selection.call == 0 || selection.call > 100000)
      throw std::runtime_error("test_fault_call_invalid");
    if (next == std::string_view::npos) break;
    text.remove_prefix(next + 1);
  }
  if (result.count == 0 || (result.count == 2 && result.selections[0].point == result.selections[1].point))
    throw std::runtime_error("test_fault_selection_invalid");
  return result;
}

inline const FaultConfiguration& configuration() {
  static const auto value = readConfiguration();
  return value;
}
}  // namespace detail

inline bool productFaultSelected(std::string_view point) {
  const auto& configuration = detail::configuration();
  for (std::size_t index = 0; index < configuration.count; ++index)
    if (configuration.selections[index].point == point) return true;
  return false;
}

// Test builds alone read this sidecar. At most two chosen calls record entry,
// then behave like platform calls that cannot be cancelled. A second point can
// hold cancellation while connect is already held. No worker is spawned: the
// real owners remain held until the outer process boundary exits.
inline void holdProductFault(std::string_view point) {
  const auto& configuration = detail::configuration();
  static std::array<std::atomic_uint, 2> calls{};
  const detail::FaultSelection* selected = nullptr;
  for (std::size_t index = 0; index < configuration.count; ++index) {
    if (configuration.selections[index].point != point) continue;
    if (calls[index].fetch_add(1, std::memory_order_relaxed) + 1 != configuration.selections[index].call) return;
    selected = &configuration.selections[index];
    break;
  }
  if (!selected) return;
  detail::Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!event.value) throw std::runtime_error("test_fault_event_failed");
  const auto marker = configuration.directory + L"\\native-test-fault-held-" +
      std::to_wstring(GetCurrentProcessId()) + L"-" + std::wstring(point.begin(), point.end()) + L".json";
  {
    detail::Handle file(CreateFileW(marker.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) throw std::runtime_error("test_fault_marker_open_failed");
    const auto record = "{\"point\":\"" + selected->point + "\",\"call\":" +
        std::to_string(selected->call) + ",\"pid\":" + std::to_string(GetCurrentProcessId()) + "}\n";
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
inline bool productFaultSelected(std::string_view) noexcept { return false; }
inline void holdProductFault(std::string_view) noexcept {}
}  // namespace syrnike::windows_media::testing
#endif
