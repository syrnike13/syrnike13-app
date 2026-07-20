#include "diagnostic_log.hpp"

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <filesystem>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include <share.h>

namespace syrnike::desktop_native::diagnostics {
namespace {

constexpr wchar_t kLogPathEnv[] = L"SYRNIKE_NATIVE_MEDIA_LOG_PATH";
constexpr wchar_t kRunIdEnv[] = L"SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID";
constexpr wchar_t kAppVersionEnv[] = L"SYRNIKE_NATIVE_APP_VERSION";
constexpr wchar_t kReleaseChannelEnv[] = L"SYRNIKE_NATIVE_RELEASE_CHANNEL";
constexpr wchar_t kContractVersionEnv[] = L"SYRNIKE_NATIVE_CONTRACT_VERSION";
constexpr wchar_t kLiveKitVersionEnv[] = L"SYRNIKE_NATIVE_LIVEKIT_VERSION";
constexpr wchar_t kCommitShaEnv[] = L"SYRNIKE_NATIVE_COMMIT_SHA";
constexpr std::size_t kMaxQueuedLines = 4096;
constexpr std::size_t kMaxBatchLines = 128;
constexpr std::size_t kMaxDiagnosticTextLength = 4096;
constexpr std::uint64_t kMaxLiveKitTraceBytes = 64ULL * 1024ULL * 1024ULL;

std::string narrowUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const auto size = WideCharToMultiByte(
    CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr
  );
  if (size <= 0) return {};
  std::string result(static_cast<std::size_t>(size), '\0');
  const auto converted = WideCharToMultiByte(
    CP_UTF8,
    0,
    value.data(),
    static_cast<int>(value.size()),
    result.data(),
    size,
    nullptr,
    nullptr
  );
  if (converted <= 0) return {};
  return result;
}

std::wstring readEnvironment(std::wstring_view name) {
  const auto required = GetEnvironmentVariableW(name.data(), nullptr, 0);
  if (required == 0) return {};
  std::wstring result(required, L'\0');
  const auto written = GetEnvironmentVariableW(
    name.data(), result.data(), static_cast<DWORD>(result.size())
  );
  if (written == 0) return {};
  result.resize(written);
  return result;
}

std::string makeRunId() {
  FILETIME file_time{};
  GetSystemTimeAsFileTime(&file_time);
  const auto now_100ns =
    (static_cast<std::uint64_t>(file_time.dwHighDateTime) << 32) | file_time.dwLowDateTime;
  const auto tick_count = static_cast<std::uint64_t>(GetTickCount64());
  char buffer[96];
  const auto written = std::snprintf(
    buffer,
    sizeof(buffer),
    "%lu-%016llx-%016llx",
    static_cast<unsigned long>(GetCurrentProcessId()),
    static_cast<unsigned long long>(now_100ns),
    static_cast<unsigned long long>(tick_count)
  );
  if (written <= 0) return "unknown";
  return std::string(buffer, static_cast<std::size_t>(written));
}

std::string escapeJson(std::string_view value) {
  std::string escaped;
  escaped.reserve(value.size() + 16);
  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\': escaped += "\\\\"; break;
      case '"': escaped += "\\\""; break;
      case '\b': escaped += "\\b"; break;
      case '\f': escaped += "\\f"; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default:
        if (ch < 0x20) {
          char buffer[7];
          const auto written = std::snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          if (written > 0) escaped.append(buffer, static_cast<std::size_t>(written));
        } else {
          escaped.push_back(static_cast<char>(ch));
        }
        break;
    }
  }
  return escaped;
}

bool isTokenDelimiter(char ch) noexcept {
  switch (ch) {
    case ' ':
    case '\t':
    case '\r':
    case '\n':
    case '"':
    case '\'':
    case ',':
    case ';':
    case ')':
    case '(':
    case ']':
    case '[':
    case '}':
    case '{':
    case '<':
    case '>':
      return true;
    default:
      return false;
  }
}

void replaceSpan(
  std::string& target,
  std::size_t start,
  std::size_t length,
  std::string_view replacement
) {
  target.replace(start, length, replacement.data(), replacement.size());
}

void redactUrls(std::string& value) {
  std::size_t scan = 0;
  while (scan < value.size()) {
    const auto pos = value.find("://", scan);
    if (pos == std::string::npos) return;
    std::size_t scheme_start = pos;
    while (scheme_start > 0) {
      const char ch = value[scheme_start - 1];
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
        --scheme_start;
        continue;
      }
      break;
    }
    const auto scheme = value.substr(scheme_start, pos - scheme_start);
    if (
      scheme != "http" && scheme != "https" && scheme != "ws" && scheme != "wss"
    ) {
      scan = pos + 3;
      continue;
    }
    std::size_t end = pos + 3;
    while (end < value.size() && !isTokenDelimiter(value[end])) ++end;
    replaceSpan(value, scheme_start, end - scheme_start, "<redacted:url>");
    scan = scheme_start + 14;
  }
}

void redactJwt(std::string& value) {
  std::size_t scan = 0;
  while (scan < value.size()) {
    const auto pos = value.find("eyJ", scan);
    if (pos == std::string::npos) return;
    auto is_part = [](char ch) noexcept {
      return
        (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') || ch == '_' || ch == '-';
    };
    std::size_t first_dot = pos + 3;
    while (first_dot < value.size() && is_part(value[first_dot])) ++first_dot;
    if (first_dot >= value.size() || value[first_dot] != '.') {
      scan = pos + 3;
      continue;
    }
    std::size_t second_dot = first_dot + 1;
    while (second_dot < value.size() && is_part(value[second_dot])) ++second_dot;
    if (second_dot >= value.size() || value[second_dot] != '.') {
      scan = first_dot + 1;
      continue;
    }
    std::size_t end = second_dot + 1;
    while (end < value.size() && is_part(value[end])) ++end;
    if (end == second_dot + 1) {
      scan = second_dot + 1;
      continue;
    }
    replaceSpan(value, pos, end - pos, "<redacted:jwt>");
    scan = pos + 14;
  }
}

std::string asciiLower(std::string_view value);

void redactNamedSecrets(std::string& value) {
  constexpr std::string_view patterns[] = {
    "token=", "token:", "access_token=", "access_token:",
    "livekit_token=", "livekit_token:", "authorization=", "authorization:",
    "bearer ", "jwt=", "jwt:"
  };
  for (const auto pattern : patterns) {
    std::size_t scan = 0;
    while (scan < value.size()) {
      const auto lower = asciiLower(value);
      const auto pos = lower.find(pattern, scan);
      if (pos == std::string::npos) break;
      std::size_t secret_start = pos + pattern.size();
      while (
        secret_start < value.size() &&
        (value[secret_start] == ' ' || value[secret_start] == '\t')
      ) {
        ++secret_start;
      }
      const char quote =
        secret_start < value.size() &&
          (value[secret_start] == '"' || value[secret_start] == '\'')
        ? value[secret_start]
        : '\0';
      if (quote != '\0') ++secret_start;
      std::size_t end = secret_start;
      if (quote != '\0') {
        while (end < value.size() && value[end] != quote) ++end;
      } else {
        while (end < value.size() && !isTokenDelimiter(value[end])) ++end;
      }
      replaceSpan(value, secret_start, end - secret_start, "<redacted:token>");
      scan = secret_start + 16;
    }
  }
}

std::string asciiLower(std::string_view value) {
  std::string result(value);
  std::transform(result.begin(), result.end(), result.begin(), [](unsigned char ch) {
    return static_cast<char>(ch >= 'A' && ch <= 'Z' ? ch + ('a' - 'A') : ch);
  });
  return result;
}

bool isSensitiveFieldKey(std::string_view key) {
  const auto lower = asciiLower(key);
  if (
    lower == "room" || lower == "window" || lower == "device" ||
    lower == "source" || lower == "path"
  ) {
    return true;
  }
  constexpr std::string_view fragments[] = {
    "token", "authorization", "url", "identity", "participant", "userid",
    "user_id", "deviceid", "device_id", "devicename", "device_name",
    "sourceid", "source_id", "windowtitle", "window_title", "hwnd",
    "roomid", "room_id", "roomname", "room_name", "processid", "process_id",
    "processpath", "process_path"
  };
  for (const auto fragment : fragments) {
    if (lower.find(fragment) != std::string::npos) return true;
  }
  return false;
}

void redactNamedPrivateValues(std::string& value) {
  constexpr std::string_view patterns[] = {
    "identity=", "identity:", "participant=", "participant:",
    "participant_identity=", "participant_identity:",
    "participantidentity=", "participantidentity:",
    "user_id=", "user_id:", "userid=", "userid:",
    "room=", "room:", "room_id=", "room_id:", "roomid=", "roomid:",
    "room_name=", "room_name:", "roomname=", "roomname:",
    "device=", "device:", "device_id=", "device_id:",
    "deviceid=", "deviceid:", "device_name=", "device_name:",
    "source_id=", "source_id:", "sourceid=", "sourceid:",
    "window_title=", "window_title:", "windowtitle=", "windowtitle:",
    "process_path=", "process_path:", "processpath=", "processpath:"
  };
  for (const auto pattern : patterns) {
    std::size_t scan = 0;
    while (scan < value.size()) {
      const auto lower = asciiLower(value);
      const auto pos = lower.find(pattern, scan);
      if (pos == std::string::npos) break;
      std::size_t start = pos + pattern.size();
      while (start < value.size() && (value[start] == ' ' || value[start] == '\t')) ++start;
      const char quote = start < value.size() && (value[start] == '"' || value[start] == '\'')
        ? value[start]
        : '\0';
      if (quote != '\0') ++start;
      std::size_t end = start;
      if (quote != '\0') {
        while (end < value.size() && value[end] != quote) ++end;
      } else {
        while (end < value.size() && !isTokenDelimiter(value[end])) ++end;
      }
      replaceSpan(value, start, end - start, "<redacted:private>");
      scan = start + 18;
    }
  }
}

void redactWindowsPaths(std::string& value) {
  std::size_t scan = 0;
  while (scan + 2 < value.size()) {
    const auto colon = value.find(':', scan + 1);
    if (colon == std::string::npos || colon == 0 || colon + 1 >= value.size()) return;
    const char drive = value[colon - 1];
    const char slash = value[colon + 1];
    const bool drive_letter =
      (drive >= 'a' && drive <= 'z') || (drive >= 'A' && drive <= 'Z');
    if (!drive_letter || (slash != '\\' && slash != '/')) {
      scan = colon + 1;
      continue;
    }
    std::size_t end = colon + 2;
    while (end < value.size()) {
      const char ch = value[end];
      if (ch == '"' || ch == '\'' || ch == '\r' || ch == '\n' ||
          ch == ',' || ch == ';' || ch == ']' || ch == '}') {
        break;
      }
      ++end;
    }
    replaceSpan(value, colon - 1, end - (colon - 1), "<redacted:path>");
    scan = colon - 1 + 15;
  }
}

std::string serializeValue(const DiagnosticField::Value& value) noexcept {
  try {
    switch (value.index()) {
      case 0:
        return "null";
      case 1:
        return std::get<bool>(value) ? "true" : "false";
      case 2:
        return std::to_string(std::get<std::int64_t>(value));
      case 3:
        return std::to_string(std::get<std::uint64_t>(value));
      case 4: {
        char buffer[64];
        const auto written = std::snprintf(
          buffer, sizeof(buffer), "%.6f", std::get<double>(value)
        );
        return written > 0 ? std::string(buffer, static_cast<std::size_t>(written)) : "0";
      }
      case 5:
      default:
        return "\"" + escapeJson(redactForDiagnostics(std::get<std::string>(value))) + "\"";
    }
  } catch (...) {
    return "\"<diagnostic-serialize-error>\"";
  }
}

class DiagnosticLogState final {
 public:
  static DiagnosticLogState& instance() noexcept {
    static DiagnosticLogState state;
    return state;
  }

  void initializeForMediaProcess() noexcept {
    if (initialized_.exchange(true)) return;
    try {
      const auto configured = readEnvironment(kLogPathEnv);
      if (configured.empty()) return;
      run_id_ = narrowUtf8(readEnvironment(kRunIdEnv));
      if (run_id_.empty()) run_id_ = makeRunId();
      if (run_id_.size() > 256) run_id_.resize(256);
      path_ = configured;
      if (path_.empty()) return;
      const auto parent = std::filesystem::path(path_).parent_path();
      if (!parent.empty()) std::filesystem::create_directories(parent);
      std::error_code file_size_error;
      written_bytes_ = std::filesystem::exists(path_)
        ? std::filesystem::file_size(path_, file_size_error)
        : 0;
      if (file_size_error) written_bytes_ = 0;
      file_ = _wfsopen(path_.c_str(), L"ab", _SH_DENYNO);
      if (!file_) return;
      setvbuf(file_, nullptr, _IOFBF, 64 * 1024);
      base_steady_ = std::chrono::steady_clock::now();
      enabled_.store(true);
      worker_ = std::thread([this] { writerLoop(); });
      write(
        "diagnostic_logger_started",
        {
          {"runId", run_id_},
          {"pid", static_cast<std::uint64_t>(GetCurrentProcessId())},
          {"architectureBits", static_cast<std::uint64_t>(sizeof(void*) * 8)},
          {"appVersion", narrowUtf8(readEnvironment(kAppVersionEnv))},
          {"releaseChannel", narrowUtf8(readEnvironment(kReleaseChannelEnv))},
          {"contractVersion", narrowUtf8(readEnvironment(kContractVersionEnv))},
          {"livekitVersion", narrowUtf8(readEnvironment(kLiveKitVersionEnv))},
          {"commitSha", narrowUtf8(readEnvironment(kCommitShaEnv))}
        }
      );
    } catch (...) {
      enabled_.store(false);
    }
  }

  void shutdown() noexcept {
    enabled_.store(false);
    {
      std::lock_guard lock(mutex_);
      stop_requested_ = true;
    }
    ready_.notify_all();
    if (worker_.joinable()) worker_.join();
    if (file_) {
      std::fflush(file_);
      std::fclose(file_);
      file_ = nullptr;
    }
  }

  [[nodiscard]] bool enabled() const noexcept { return enabled_.load(); }

  [[nodiscard]] std::string runId() const noexcept {
    std::lock_guard lock(mutex_);
    return run_id_;
  }

  [[nodiscard]] std::uint64_t steadyNowMs() const noexcept {
    const auto now = std::chrono::steady_clock::now();
    return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(now - base_steady_).count()
    );
  }

  void write(
    std::string_view event,
    std::initializer_list<DiagnosticField> fields
  ) noexcept {
    if (!enabled()) return;
    std::string line;
    try {
      line.reserve(512);
      const auto wall_now = std::chrono::system_clock::now();
      const auto wall_ms = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
          wall_now.time_since_epoch()
        ).count()
      );
      const auto steady_ms = steadyNowMs();
      const auto tid = static_cast<std::uint64_t>(GetCurrentThreadId());
      const auto sequence = sequence_.fetch_add(1) + 1;
      line += "{\"event\":\"";
      line += escapeJson(event);
      line += "\",\"runtime\":\"media\",\"role\":\"native";
      line += "\",\"runId\":\"";
      {
        std::lock_guard lock(mutex_);
        line += escapeJson(run_id_);
      }
      line += "\",\"sequence\":";
      line += std::to_string(sequence);
      line += ",\"pid\":";
      line += std::to_string(static_cast<std::uint64_t>(GetCurrentProcessId()));
      line += ",\"tid\":";
      line += std::to_string(tid);
      line += ",\"wallTimeUnixMs\":";
      line += std::to_string(wall_ms);
      line += ",\"steadyTimeMs\":";
      line += std::to_string(steady_ms);
      for (const auto& field : fields) {
        if (isSensitiveFieldKey(field.key)) continue;
        line += ",\"";
        line += escapeJson(field.key);
        line += "\":";
        line += serializeValue(field.value);
      }
      const auto dropped = dropped_lines_.exchange(0);
      if (dropped > 0) {
        line += ",\"droppedLines\":";
        line += std::to_string(dropped);
      }
      line += "}\n";
    } catch (...) {
      return;
    }

    const bool is_trace = event == "media_runtime_livekit_trace";
    {
      std::lock_guard lock(mutex_);
      if (stop_requested_ || !file_) return;
      if (lines_.size() >= kMaxQueuedLines) {
        if (is_trace) {
          dropped_lines_.fetch_add(1);
          return;
        }
        const auto trace = std::find_if(lines_.begin(), lines_.end(), [](const auto& queued) {
          return queued.is_trace;
        });
        if (trace == lines_.end()) {
          dropped_lines_.fetch_add(1);
          return;
        }
        lines_.erase(trace);
        dropped_lines_.fetch_add(1);
      }
      lines_.push_back(QueuedLine{std::move(line), is_trace});
    }
    ready_.notify_one();
  }

 private:
  DiagnosticLogState() = default;
  ~DiagnosticLogState() { shutdown(); }
  DiagnosticLogState(const DiagnosticLogState&) = delete;
  DiagnosticLogState& operator=(const DiagnosticLogState&) = delete;

  void writerLoop() noexcept {
    std::vector<QueuedLine> batch;
    batch.reserve(kMaxBatchLines);
    while (true) {
      {
        std::unique_lock lock(mutex_);
        ready_.wait_for(lock, std::chrono::milliseconds(100), [&] {
          return stop_requested_ || !lines_.empty();
        });
        if (stop_requested_ && lines_.empty()) break;
        while (!lines_.empty() && batch.size() < kMaxBatchLines) {
          batch.push_back(std::move(lines_.front()));
          lines_.pop_front();
        }
      }
      if (!file_) {
        batch.clear();
        continue;
      }
      for (const auto& line : batch) writeLine(line);
      std::fflush(file_);
      batch.clear();
    }
    if (!file_) return;
    std::lock_guard lock(mutex_);
    while (!lines_.empty()) {
      writeLine(lines_.front());
      lines_.pop_front();
    }
    std::fflush(file_);
  }

  std::atomic_bool initialized_{false};
  std::atomic_bool enabled_{false};
  std::atomic_uint64_t sequence_{0};
  std::atomic_uint64_t dropped_lines_{0};
  mutable std::mutex mutex_;
  std::condition_variable ready_;
  struct QueuedLine {
    std::string content;
    bool is_trace = false;
  };

  void writeLine(const QueuedLine& line) noexcept {
    if (line.is_trace && written_bytes_ >= kMaxLiveKitTraceBytes) {
      dropped_lines_.fetch_add(1);
      return;
    }
    written_bytes_ += static_cast<std::uint64_t>(
      std::fwrite(line.content.data(), 1, line.content.size(), file_)
    );
  }

  std::deque<QueuedLine> lines_;
  std::thread worker_;
  FILE* file_ = nullptr;
  bool stop_requested_ = false;
  std::chrono::steady_clock::time_point base_steady_{std::chrono::steady_clock::now()};
  std::wstring path_;
  std::string run_id_;
  std::uint64_t written_bytes_ = 0;
};

}  // namespace

std::string redactForDiagnostics(std::string_view value) noexcept {
  try {
    std::string redacted(value);
    redactUrls(redacted);
    redactJwt(redacted);
    redactNamedSecrets(redacted);
    redactNamedPrivateValues(redacted);
    redactWindowsPaths(redacted);
    if (redacted.size() > kMaxDiagnosticTextLength) {
      redacted.resize(kMaxDiagnosticTextLength);
    }
    return redacted;
  } catch (...) {
    return "<diagnostic-redaction-error>";
  }
}

DiagnosticLog& DiagnosticLog::instance() noexcept {
  static DiagnosticLog log;
  return log;
}

void DiagnosticLog::initializeForMediaProcess() noexcept {
  DiagnosticLogState::instance().initializeForMediaProcess();
}

void DiagnosticLog::shutdown() noexcept {
  DiagnosticLogState::instance().shutdown();
}

bool DiagnosticLog::enabled() const noexcept {
  return DiagnosticLogState::instance().enabled();
}

std::string DiagnosticLog::runId() const noexcept {
  return DiagnosticLogState::instance().runId();
}

std::uint64_t DiagnosticLog::steadyNowMs() const noexcept {
  return DiagnosticLogState::instance().steadyNowMs();
}

void DiagnosticLog::write(
  std::string_view event,
  std::initializer_list<DiagnosticField> fields
) noexcept {
  DiagnosticLogState::instance().write(event, fields);
}

}  // namespace syrnike::desktop_native::diagnostics
