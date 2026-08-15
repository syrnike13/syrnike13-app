#include "windows_process_resource_snapshot.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include <windows.h>
#include <tlhelp32.h>

namespace syrnike::desktop_native::tests {
namespace {

constexpr std::size_t kMaximumTypes = 64;
constexpr std::size_t kMaximumCategoryBytes = 64;
constexpr std::size_t kInitialHandleBufferBytes = 1U << 20;
constexpr std::size_t kMaximumHandleBufferBytes = 16U << 20;
constexpr LONG kStatusInfoLengthMismatch = static_cast<LONG>(0xC0000004L);
constexpr ULONG kSystemExtendedHandleInformation = 64;
constexpr ULONG kObjectTypeInformation = 2;
constexpr ULONG kThreadQuerySetWin32StartAddress = 9;

struct ScopedHandle final {
  HANDLE value = nullptr;
  ~ScopedHandle() {
    if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
  }
};

struct NativeUnicodeString {
  USHORT length;
  USHORT maximum_length;
  PWSTR buffer;
};

struct NativeObjectTypeInformation {
  NativeUnicodeString type_name;
};

struct NativeSystemHandleEntry {
  PVOID object;
  ULONG_PTR process_id;
  ULONG_PTR handle_value;
  ULONG granted_access;
  USHORT creator_backtrace_index;
  USHORT object_type_index;
  ULONG handle_attributes;
  ULONG reserved;
};

struct NativeSystemHandleInformation {
  ULONG_PTR count;
  ULONG_PTR reserved;
  NativeSystemHandleEntry entries[1];
};

using NtQuerySystemInformation = LONG(NTAPI*)(
    ULONG, PVOID, ULONG, PULONG);
using NtQueryObject = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
using NtQueryInformationThread = LONG(NTAPI*)(
    HANDLE, ULONG, PVOID, ULONG, PULONG);

std::string sanitize(std::wstring_view value) {
  std::string result;
  result.reserve(std::min(value.size(), kMaximumCategoryBytes));
  for (const auto ch : value) {
    if (result.size() == kMaximumCategoryBytes) break;
    const auto ascii = static_cast<unsigned>(ch);
    const auto safe = (ascii >= 'a' && ascii <= 'z') ||
        (ascii >= 'A' && ascii <= 'Z') ||
        (ascii >= '0' && ascii <= '9') || ascii == '_' || ascii == '.' ||
        ascii == '-';
    result.push_back(safe ? static_cast<char>(ascii) : '_');
  }
  return result.empty() ? "unnamed" : result;
}

std::string moduleCategory(void* address) {
  if (!address) return "unknown_module";
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(address), &module)) {
    return "unknown_module";
  }
  std::array<wchar_t, MAX_PATH> path{};
  const auto length = GetModuleFileNameW(
      module, path.data(), static_cast<DWORD>(path.size()));
  if (length == 0 || length >= path.size()) return "unknown_module";
  std::wstring_view name(path.data(), length);
  const auto separator = name.find_last_of(L"\\/");
  if (separator != std::wstring_view::npos) name.remove_prefix(separator + 1);
  return sanitize(name);
}

ResourceTypeCounts boundedCounts(const std::map<std::string, std::size_t>& counts) {
  ResourceTypeCounts result;
  result.reserve(std::min(counts.size(), kMaximumTypes));
  for (const auto& [category, count] : counts) {
    if (result.size() == kMaximumTypes) break;
    result.push_back({category, count});
  }
  return result;
}

ResourceTypeCounts captureThreadTypes(HMODULE ntdll) {
  std::map<std::string, std::size_t> counts;
  const auto query_start = reinterpret_cast<NtQueryInformationThread>(
      GetProcAddress(ntdll, "NtQueryInformationThread"));
  ScopedHandle snapshot{CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)};
  if (snapshot.value == INVALID_HANDLE_VALUE) return {};
  THREADENTRY32 entry{};
  entry.dwSize = sizeof(entry);
  if (!Thread32First(snapshot.value, &entry)) return {};
  do {
    if (entry.th32OwnerProcessID != GetCurrentProcessId()) continue;
    ScopedHandle thread{OpenThread(
        THREAD_QUERY_INFORMATION | THREAD_QUERY_LIMITED_INFORMATION,
        FALSE, entry.th32ThreadID)};
    if (!thread.value) {
      ++counts["unavailable_thread"];
      continue;
    }
    PWSTR description = nullptr;
    std::string category;
    if (SUCCEEDED(GetThreadDescription(thread.value, &description)) &&
        description) {
      category = sanitize(description);
      LocalFree(description);
    }
    void* start_address = nullptr;
    if (query_start && query_start(
            thread.value, kThreadQuerySetWin32StartAddress,
            &start_address, sizeof(start_address), nullptr) >= 0) {
      const auto module = moduleCategory(start_address);
      category = category.empty() ? module : category + "@" + module;
      if (category.size() > kMaximumCategoryBytes) {
        category.resize(kMaximumCategoryBytes);
      }
    }
    if (category.empty()) category = "unnamed_thread";
    ++counts[category];
  } while (Thread32Next(snapshot.value, &entry));
  return boundedCounts(counts);
}

std::string queryObjectTypeName(NtQueryObject query, HANDLE handle) {
  ULONG required = 0;
  static_cast<void>(query(handle, kObjectTypeInformation, nullptr, 0, &required));
  if (required == 0 || required > 64U * 1024U) return {};
  std::vector<std::byte> buffer(required);
  if (query(handle, kObjectTypeInformation, buffer.data(), required, &required) < 0) {
    return {};
  }
  const auto* information =
      reinterpret_cast<const NativeObjectTypeInformation*>(buffer.data());
  if (!information->type_name.buffer || information->type_name.length == 0) {
    return {};
  }
  return sanitize(std::wstring_view(
      information->type_name.buffer,
      information->type_name.length / sizeof(wchar_t)));
}

ResourceTypeCounts captureHandleTypes(HMODULE ntdll) {
  const auto query_system = reinterpret_cast<NtQuerySystemInformation>(
      GetProcAddress(ntdll, "NtQuerySystemInformation"));
  const auto query_object = reinterpret_cast<NtQueryObject>(
      GetProcAddress(ntdll, "NtQueryObject"));
  if (!query_system || !query_object) return {};

  std::vector<std::byte> buffer(kInitialHandleBufferBytes);
  ULONG required = 0;
  LONG status = kStatusInfoLengthMismatch;
  while (status == kStatusInfoLengthMismatch &&
         buffer.size() <= kMaximumHandleBufferBytes) {
    status = query_system(
        kSystemExtendedHandleInformation, buffer.data(),
        static_cast<ULONG>(buffer.size()), &required);
    if (status != kStatusInfoLengthMismatch) break;
    const auto next = std::max<std::size_t>(buffer.size() * 2, required);
    if (next > kMaximumHandleBufferBytes) return {};
    buffer.resize(next);
  }
  if (status < 0) return {};

  const auto* information =
      reinterpret_cast<const NativeSystemHandleInformation*>(buffer.data());
  std::map<USHORT, std::size_t> counts;
  std::unordered_map<USHORT, HANDLE> representatives;
  const auto process_id = static_cast<ULONG_PTR>(GetCurrentProcessId());
  for (ULONG_PTR index = 0; index < information->count; ++index) {
    const auto& entry = information->entries[index];
    if (entry.process_id != process_id) continue;
    ++counts[entry.object_type_index];
    representatives.try_emplace(
        entry.object_type_index,
        reinterpret_cast<HANDLE>(entry.handle_value));
  }

  std::map<std::string, std::size_t> named;
  for (const auto& [type_index, count] : counts) {
    auto name = queryObjectTypeName(query_object, representatives[type_index]);
    if (name.empty()) name = "type_" + std::to_string(type_index);
    named[name] += count;
  }
  return boundedCounts(named);
}

}  // namespace

ResourceTypeCounts resourceTypeDelta(
    const ResourceTypeCounts& baseline,
    const ResourceTypeCounts& observed,
    std::size_t maximum_types) {
  std::map<std::string, std::size_t> previous;
  for (const auto& value : baseline) previous[value.category] += value.count;
  ResourceTypeCounts result;
  for (const auto& value : observed) {
    const auto before = previous[value.category];
    if (value.count > before) {
      result.push_back({value.category, value.count - before});
    }
  }
  std::sort(result.begin(), result.end(), [](const auto& left, const auto& right) {
    if (left.count != right.count) return left.count > right.count;
    return left.category < right.category;
  });
  if (result.size() > maximum_types) result.resize(maximum_types);
  return result;
}

WindowsProcessResourceTypes captureWindowsProcessResourceTypes() noexcept {
  try {
    const auto ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) return {};
    return {captureThreadTypes(ntdll), captureHandleTypes(ntdll)};
  } catch (...) {
    return {};
  }
}

}  // namespace syrnike::desktop_native::tests
