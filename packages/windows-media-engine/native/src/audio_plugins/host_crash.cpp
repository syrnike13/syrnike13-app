#include "audio_plugins/host_crash.hpp"

#include <windows.h>
#include <dbghelp.h>

#include <cstdio>
#include <cstring>

namespace syrnike::windows_media::audio_plugins {
namespace {
thread_local const char* tl_role = "other";
HANDLE g_protocol = nullptr;
wchar_t g_dump_directory[MAX_PATH] = {};
volatile LONG g_reporting = 0;

// JSON string body without allocation; drops characters that need escaping.
void appendSafe(char* out, std::size_t size, const char* text) {
  std::size_t length = std::strlen(out);
  for (; text && *text && length + 1 < size; ++text) {
    const unsigned char letter = static_cast<unsigned char>(*text);
    if (letter < 0x20 || letter == '"' || letter == '\\') continue;
    out[length++] = static_cast<char>(letter);
  }
  out[length] = '\0';
}

void moduleOf(const void* address, char* out, std::size_t size) {
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          static_cast<LPCWSTR>(address), &module)) {
    std::snprintf(out, size, "unknown");
    return;
  }
  wchar_t path[MAX_PATH] = {};
  GetModuleFileNameW(module, path, MAX_PATH);
  const wchar_t* name = std::wcsrchr(path, L'\\');
  name = name ? name + 1 : path;
  char narrow[MAX_PATH] = {};
  WideCharToMultiByte(CP_UTF8, 0, name, -1, narrow, sizeof(narrow), nullptr, nullptr);
  out[0] = '\0';
  appendSafe(out, size, narrow);
  const auto offset = static_cast<unsigned long long>(
      static_cast<const char*>(address) - reinterpret_cast<const char*>(module));
  char suffix[32];
  std::snprintf(suffix, sizeof(suffix), "+0x%llx", offset);
  appendSafe(out, size, suffix);
}

void writeDump(EXCEPTION_POINTERS* info, char* dump_name, std::size_t size) {
  dump_name[0] = '\0';
  if (!g_dump_directory[0]) return;
  SYSTEMTIME time;
  GetLocalTime(&time);
  wchar_t path[MAX_PATH];
  swprintf_s(path, L"%s\\plugin-host-%04u%02u%02u-%02u%02u%02u-%lu.dmp", g_dump_directory, time.wYear,
             time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, GetCurrentProcessId());
  const HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return;
  MINIDUMP_EXCEPTION_INFORMATION exception{GetCurrentThreadId(), info, FALSE};
  const auto type = static_cast<MINIDUMP_TYPE>(MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules |
                                               MiniDumpWithIndirectlyReferencedMemory);
  const BOOL written = MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), file, type, &exception,
                                         nullptr, nullptr);
  CloseHandle(file);
  if (!written) return;
  const wchar_t* name = std::wcsrchr(path, L'\\');
  WideCharToMultiByte(CP_UTF8, 0, name ? name + 1 : path, -1, dump_name, static_cast<int>(size), nullptr, nullptr);
}

LONG WINAPI onUnhandledException(EXCEPTION_POINTERS* info) {
  // A second fault while reporting must not recurse.
  if (InterlockedExchange(&g_reporting, 1)) return EXCEPTION_EXECUTE_HANDLER;
  const auto* record = info ? info->ExceptionRecord : nullptr;
  char module[300] = {}, dump[MAX_PATH] = {}, activity[300] = {};
  if (record) moduleOf(record->ExceptionAddress, module, sizeof(module));
  const char* current = PluginActivity::current();
  appendSafe(activity, sizeof(activity), current ? current : "");
  writeDump(info, dump, sizeof(dump));
  char line[1200];
  std::snprintf(line, sizeof(line),
                "{\"event\":\"crash\",\"code\":\"0x%08lX\",\"module\":\"%s\",\"thread\":\"%s\",\"activity\":\"%s\","
                "\"dump\":\"%s\"}\n",
                record ? static_cast<unsigned long>(record->ExceptionCode) : 0ul, module, tl_role, activity, dump);
  if (g_protocol) {
    DWORD written = 0;
    WriteFile(g_protocol, line, static_cast<DWORD>(std::strlen(line)), &written, nullptr);
    FlushFileBuffers(g_protocol);
  }
  return EXCEPTION_EXECUTE_HANDLER;
}
}  // namespace

namespace crash_reporting {
void install(void* protocol_handle, std::wstring dump_directory) {
  g_protocol = static_cast<HANDLE>(protocol_handle);
  if (!dump_directory.empty() && dump_directory.size() < MAX_PATH - 64) {
    CreateDirectoryW(dump_directory.c_str(), nullptr);
    wcsncpy_s(g_dump_directory, dump_directory.c_str(), _TRUNCATE);
  }
  rearm();
}
void rearm() noexcept { SetUnhandledExceptionFilter(onUnhandledException); }
void markAudioThread() noexcept { tl_role = "audio"; }
void markUiThread() noexcept { tl_role = "ui"; }
}  // namespace crash_reporting
}  // namespace syrnike::windows_media::audio_plugins
