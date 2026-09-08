#pragma once

#include <windows.h>
#include <tlhelp32.h>

#include <cstdint>
#include <iostream>
#include <sstream>
#include <string>

namespace syrnike::windows_media::probe {

// Probe-only diagnostics. Resolve the optional OS query dynamically and report
// module-relative offsets, never machine paths or process memory addresses.
inline void logResourceThreads(const char* phase) {
  wchar_t enabled[2]{};
  if (GetEnvironmentVariableW(L"WINDOWS_MEDIA_CAPTURE_THREAD_DIAGNOSTIC",
                              enabled, 2) != 1 || enabled[0] != L'1') {
    return;
  }
  using QueryThread = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  const auto query = reinterpret_cast<QueryThread>(GetProcAddress(
      GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationThread"));
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return;

  std::ostringstream output;
  output << "CAPTURE_RESOURCE_THREADS {\"phase\":\"" << phase
         << "\",\"threads\":[";
  THREADENTRY32 entry{};
  entry.dwSize = sizeof(entry);
  bool first = true;
  if (Thread32First(snapshot, &entry)) {
    do {
      if (entry.th32OwnerProcessID != GetCurrentProcessId()) continue;
      if (!first) output << ',';
      first = false;
      output << "{\"id\":" << entry.th32ThreadID;
      const HANDLE thread =
          OpenThread(THREAD_QUERY_INFORMATION, FALSE, entry.th32ThreadID);
      PVOID start = nullptr;
      constexpr ULONG kThreadQuerySetWin32StartAddress = 9;
      if (thread && query &&
          query(thread, kThreadQuerySetWin32StartAddress, &start,
                sizeof(start), nullptr) >= 0) {
        MEMORY_BASIC_INFORMATION memory{};
        char path[MAX_PATH]{};
        if (VirtualQuery(start, &memory, sizeof(memory)) == sizeof(memory) &&
            GetModuleFileNameA(static_cast<HMODULE>(memory.AllocationBase),
                               path, MAX_PATH) > 0) {
          std::string module(path);
          module = module.substr(module.find_last_of("\\/") + 1);
          for (auto& character : module) {
            if (!((character >= 'a' && character <= 'z') ||
                  (character >= 'A' && character <= 'Z') ||
                  (character >= '0' && character <= '9') ||
                  character == '.' || character == '_' || character == '-')) {
              character = '_';
            }
          }
          const auto offset = reinterpret_cast<std::uintptr_t>(start) -
              reinterpret_cast<std::uintptr_t>(memory.AllocationBase);
          output << ",\"module\":\"" << module << "\",\"offset\":\"0x"
                 << std::hex << offset << std::dec << '"';
        }
      }
      if (thread) CloseHandle(thread);
      output << '}';
    } while (Thread32Next(snapshot, &entry));
  }
  CloseHandle(snapshot);
  output << "]}\n";
  std::cerr << output.str();
}

}  // namespace syrnike::windows_media::probe
