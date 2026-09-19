#pragma once

#include <windows.h>

#include <cstddef>
#include <iostream>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace syrnike::windows_media::tests {

// Optional test-only diagnostics. Fixed storage and type names keep the output
// bounded; object names, raw handles and machine paths never enter reports.
inline void logFaultHandleTypes(std::string_view id, unsigned iteration) {
  wchar_t enabled[2]{};
  if (GetEnvironmentVariableW(L"WINDOWS_MEDIA_FAULT_HANDLE_DIAGNOSTIC", enabled, 2) != 1 ||
      enabled[0] != L'1') return;
  using Query = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  const auto library = GetModuleHandleW(L"ntdll.dll");
  const auto query_process = reinterpret_cast<Query>(GetProcAddress(library, "NtQueryInformationProcess"));
  const auto query_object = reinterpret_cast<Query>(GetProcAddress(library, "NtQueryObject"));
  if (!query_process || !query_object) return;

  struct Entry {
    HANDLE handle;
    SIZE_T handles, pointers;
    ULONG access, type, attributes, reserved;
  };
  struct Snapshot { ULONG_PTR count, reserved; Entry entries[1]; };
  struct Name { USHORT length, maximum; wchar_t* text; };
  std::vector<std::byte> buffer(1024 * 1024);
  ULONG size = 0;
  constexpr ULONG process_handle_information = 51;
  if (query_process(GetCurrentProcess(), process_handle_information, buffer.data(),
                    static_cast<ULONG>(buffer.size()), &size) < 0) return;
  const auto* snapshot = reinterpret_cast<const Snapshot*>(buffer.data());
  if (snapshot->count > (buffer.size() - offsetof(Snapshot, entries)) / sizeof(Entry)) return;
  struct Type { unsigned count = 0; std::string name; };
  std::map<ULONG, Type> types;
  for (ULONG_PTR index = 0; index < snapshot->count; ++index) {
    const auto& entry = snapshot->entries[index];
    if (!types.contains(entry.type) && types.size() >= 256) return;
    auto& type = types[entry.type];
    ++type.count;
    if (!type.name.empty()) continue;
    alignas(void*) std::byte information[2048]{};
    constexpr ULONG object_type_information = 2;
    if (query_object(entry.handle, object_type_information, information, sizeof(information), &size) < 0) continue;
    const auto* name = reinterpret_cast<const Name*>(information);
    if (name->length > 128 || !name->text) continue;
    for (unsigned character = 0; character < name->length / sizeof(wchar_t); ++character) {
      const auto value = name->text[character];
      type.name += value >= 0x20 && value <= 0x7e && value != '"' && value != '\\'
          ? static_cast<char>(value) : '_';
    }
  }
  std::cout << "FAULT_HANDLE_TYPES {\"id\":\"" << id << "\",\"iteration\":" << iteration
            << ",\"types\":[";
  bool first = true;
  for (const auto& [index, type] : types) {
    if (!first) std::cout << ',';
    first = false;
    std::cout << "{\"index\":" << index << ",\"name\":\"" << type.name
              << "\",\"count\":" << type.count << '}';
  }
  std::cout << "]}" << std::endl;
}

}  // namespace syrnike::windows_media::tests
