// Plugin host process. Electron starts one per session: it owns the effect bus
// that the microphone DSP calls every 10 ms, the effect chain, and the plugin
// editors. Plugins are third-party native code, so they never load into the
// media utility: a crash or hang here only leaves the voice dry.
//
//   syrnike_audio_plugin_host --bus <id> --parent <pid>   serve a chain
//   syrnike_audio_plugin_host --scan <module.vst3>         list its effects
//   syrnike_audio_plugin_host --list-modules               installed bundles
//   syrnike_audio_plugin_host --bench <module.vst3> --class <id> [--seconds N]
//   syrnike_audio_plugin_host --bench builtin:<kind> [--seconds N]
//   syrnike_audio_plugin_host --crash-test <label> [--crash-dir <dir>]  checks crash reports
//                                                          realtime load of one effect
//
// Exit codes: 0 shutdown, 10 stdin closed, 11 parent exited, 2 bus failure; a
// crash ends with its exception code after a {"event":"crash"} line.
//
// Control is newline-delimited JSON on stdin/stdout. The private stdout copy is
// taken before any plugin loads; the process stdout then points to NUL, so a
// plugin printing to it cannot corrupt the protocol.
#include "audio_plugins/builtin_effects.hpp"
#include "audio_plugins/effect_bus.hpp"
#include "audio_plugins/effect_chain.hpp"
#include "audio_plugins/host_crash.hpp"
#include "audio_plugins/json.hpp"
#include "audio_plugins/vst3_effect.hpp"

#include <windows.h>
#include <avrt.h>
#include <ole2.h>
#include <psapi.h>
#include <shellapi.h>

#include <algorithm>
#include <cmath>
#include <numbers>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <deque>
#include <map>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace syrnike::windows_media::audio_plugins;
namespace {
using Clock = std::chrono::steady_clock;
constexpr std::size_t kMaximumLine = 16 * 1024 * 1024;
constexpr std::size_t kMaximumSlots = 16;
constexpr UINT kInputMessage = WM_APP + 1;
constexpr auto kStateDebounce = std::chrono::milliseconds{750};

std::string narrow(const wchar_t* value) {
  const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return {};
  std::string out(static_cast<std::size_t>(size - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, out.data(), size, nullptr, nullptr);
  return out;
}

constexpr char kBase64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
std::string encodeBase64(const std::vector<std::uint8_t>& bytes) {
  std::string out;
  out.reserve((bytes.size() + 2) / 3 * 4);
  for (std::size_t index = 0; index < bytes.size(); index += 3) {
    const std::uint32_t chunk = (std::uint32_t{bytes[index]} << 16) |
        (index + 1 < bytes.size() ? std::uint32_t{bytes[index + 1]} << 8 : 0) |
        (index + 2 < bytes.size() ? std::uint32_t{bytes[index + 2]} : 0);
    out += kBase64[(chunk >> 18) & 63];
    out += kBase64[(chunk >> 12) & 63];
    out += index + 1 < bytes.size() ? kBase64[(chunk >> 6) & 63] : '=';
    out += index + 2 < bytes.size() ? kBase64[chunk & 63] : '=';
  }
  return out;
}
std::optional<std::vector<std::uint8_t>> decodeBase64(const std::string& text) {
  if (text.size() % 4) return std::nullopt;
  std::vector<std::uint8_t> out;
  out.reserve(text.size() / 4 * 3);
  const auto value = [](char letter) -> int {
    if (letter >= 'A' && letter <= 'Z') return letter - 'A';
    if (letter >= 'a' && letter <= 'z') return letter - 'a' + 26;
    if (letter >= '0' && letter <= '9') return letter - '0' + 52;
    if (letter == '+') return 62;
    if (letter == '/') return 63;
    return -1;
  };
  for (std::size_t index = 0; index < text.size(); index += 4) {
    std::uint32_t chunk = 0;
    int padding = 0;
    for (std::size_t offset = 0; offset < 4; ++offset) {
      const char letter = text[index + offset];
      if (letter == '=' && index + 4 == text.size() && offset >= 2) {
        ++padding;
        chunk <<= 6;
        continue;
      }
      const int decoded = value(letter);
      if (decoded < 0 || padding) return std::nullopt;
      chunk = (chunk << 6) | static_cast<std::uint32_t>(decoded);
    }
    out.push_back(static_cast<std::uint8_t>(chunk >> 16));
    if (padding < 2) out.push_back(static_cast<std::uint8_t>(chunk >> 8));
    if (padding < 1) out.push_back(static_cast<std::uint8_t>(chunk));
  }
  return out;
}

class Output {
 public:
  // Takes the real stdout and points the process stdout at NUL.
  Output() {
    DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE), GetCurrentProcess(), &handle_, 0, FALSE,
                    DUPLICATE_SAME_ACCESS);
    FILE* ignored = nullptr;
    freopen_s(&ignored, "NUL", "w", stdout);
    const HANDLE nul = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    SetStdHandle(STD_OUTPUT_HANDLE, nul);
  }
  void* handle() const noexcept { return handle_; }
  void write(const Json& value) {
    auto line = value.dump();
    line += '\n';
    std::lock_guard lock(mutex_);
    DWORD written = 0;
    WriteFile(handle_, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
  }
 private:
  HANDLE handle_ = nullptr;
  std::mutex mutex_;
};

Json pluginJson(const Vst3PluginInfo& info) {
  return Json::Object{{"path", info.path}, {"classId", info.class_id}, {"name", info.name},
                      {"vendor", info.vendor}, {"version", info.version}, {"subCategories", info.sub_categories}};
}

int scan(Output& output, const std::string& path) {
  std::string error;
  const auto plugins = scanVst3Module(path, error);
  Json::Array values;
  for (const auto& plugin : plugins) values.push_back(pluginJson(plugin));
  Json::Object result{{"plugins", std::move(values)}};
  if (!error.empty() && plugins.empty()) result.insert_or_assign("error", error);
  output.write(result);
  return 0;
}

// Per-slot control record. The slot itself is shared with the chains that the
// realtime thread runs; this thread is the only one that releases it.
// Set by the component handler, which plugins may call from process() on the
// realtime thread; the control thread consumes them in tick().
struct SlotSignals {
  std::atomic<bool> edited{false};
  std::atomic<bool> restart{false};
};

struct SlotRecord {
  std::string id;
  std::string kind;      // "builtin" or "vst3"
  std::string identity;  // builtin kind, or path + class id
  std::string name;
  std::shared_ptr<EffectSlot> slot;
  BuiltinEffect* builtin = nullptr;
  Vst3Effect* vst = nullptr;
  std::optional<Clock::time_point> state_due;
  std::shared_ptr<SlotSignals> signals = std::make_shared<SlotSignals>();
};

class Host {
 public:
  Host(Output& output, std::unique_ptr<EffectBusServer> bus) : output_(output), bus_(std::move(bus)) {}

  void startAudio() {
    audio_ = std::thread([this] {
      DWORD task = 0;
      const HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
      crash_reporting::markAudioThread();
      audio_thread_.store(OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE, GetCurrentThreadId()));
      while (!stopping_.load(std::memory_order_relaxed)) {
        bus_->serve(std::chrono::milliseconds{50}, [this](auto& frame) {
          if (auto* chain = exchange_.acquire()) chain->process(frame.data(), frame.size());
        });
      }
      if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    });
  }
  void stopAudio() {
    bus_->setActive(false, 0);
    stopping_ = true;
    if (audio_.joinable()) audio_.join();
    if (const HANDLE thread = audio_thread_.exchange(nullptr)) CloseHandle(thread);
  }

  // Control thread.
  void handle(const Json& command) {
    const auto* type = command["type"].string();
    if (!type) return;
    if (*type == "setChain") setChain(command);
    else if (*type == "updateSlot") updateSlot(command);
    else if (*type == "openEditor") openEditor(command);
    else if (*type == "closeEditor") withSlot(command, [](SlotRecord& record) {
      PluginActivity activity(record.slot->label().c_str());
      if (record.vst) record.vst->closeEditor();
    });
    else if (*type == "getState") getState(command);
    else if (*type == "stats") stats(command);
  }
  void tick() {
    exchange_.collect();
    const auto now = Clock::now();
    for (auto& record : records_) {
      PluginActivity activity(record.slot->label().c_str());
      if (record.vst) record.vst->pumpOutputChanges();
      if (record.signals->edited.exchange(false)) record.state_due = now + kStateDebounce;
      if (record.state_due && now >= *record.state_due) {
        record.state_due.reset();
        if (record.vst)
          output_.write(Json::Object{{"event", "state"}, {"slotId", record.id},
                                     {"state", encodeBase64(record.vst->saveState())}});
      }
    }
    restartPlugins();
  }
  // Destroys every plugin on this thread after the realtime thread stopped.
  void release() {
    PluginActivity activity("releasing plugins");
    exchange_.publish(std::make_unique<EffectChain>());
    exchange_.collect();
    records_.clear();
  }

 private:
  template <typename Action>
  void withSlot(const Json& command, Action&& action) {
    const auto* id = command["slotId"].string();
    if (!id) return;
    const auto found = std::ranges::find(records_, *id, &SlotRecord::id);
    if (found != records_.end()) action(*found);
  }
  void reply(const Json& command, Json::Object values) {
    values.insert_or_assign("type", "reply");
    values.insert_or_assign("requestId", command["requestId"]);
    output_.write(values);
  }
  void applyControls(SlotRecord& record, const Json& slot) {
    if (const auto mix = slot["mix"].number()) record.slot->setMix(static_cast<float>(*mix));
    if (const auto enabled = slot["enabled"].boolean()) record.slot->setEnabled(*enabled);
    if (const auto* params = slot["params"].object(); params && record.builtin)
      for (const auto& [name, value] : *params)
        if (const auto number = value.number()) record.builtin->setParameter(name, static_cast<float>(*number));
  }
  static Vst3Effect::Notify notifier(std::shared_ptr<SlotSignals> signals) {
    // Plugins may call the component handler from any thread, the realtime
    // one included; only raise flags here.
    return [signals = std::move(signals)](Vst3Notice notice) {
      if (notice == Vst3Notice::restart) signals->restart.store(true);
      signals->edited.store(true);
    };
  }
  SlotRecord create(const Json& slot, const std::string& id, std::string& error) {
    SlotRecord record;
    record.id = id;
    const auto* kind = slot["kind"].string();
    record.kind = kind ? *kind : "";
    if (const auto* name = slot["name"].string()) record.name = *name;
    const auto label = id + " " + (record.name.empty() ? identityOf(slot) : record.name);
    PluginActivity activity(label.c_str());
    try {
      std::unique_ptr<AudioEffect> effect;
      if (record.kind == "builtin") {
        const auto* builtin = slot["builtin"].string();
        auto value = builtin ? makeBuiltinEffect(*builtin) : nullptr;
        if (!value) throw std::runtime_error("Unknown built-in effect");
        record.identity = *builtin;
        record.builtin = value.get();
        effect = std::move(value);
      } else if (record.kind == "vst3") {
        const auto* path = slot["path"].string();
        const auto* class_id = slot["classId"].string();
        if (!path || !class_id) throw std::runtime_error("The plugin is not specified");
        std::optional<std::vector<std::uint8_t>> state;
        if (const auto* encoded = slot["state"].string()) state = decodeBase64(*encoded);
        auto value = Vst3Effect::create(*path, *class_id, state ? &*state : nullptr, notifier(record.signals));
        crash_reporting::rearm();
        record.identity = *path + "|" + *class_id;
        record.vst = value.get();
        effect = std::move(value);
      } else {
        throw std::runtime_error("Unknown effect kind");
      }
      record.slot = std::make_shared<EffectSlot>(std::move(effect), 1.0f, true, label);
      applyControls(record, slot);
    } catch (const std::exception& failure) {
      error = failure.what();
      record.slot.reset();
    }
    return record;
  }
  static std::string identityOf(const Json& slot) {
    const auto* kind = slot["kind"].string();
    if (!kind) return {};
    if (*kind == "builtin") return slot["builtin"].string() ? *slot["builtin"].string() : "";
    const auto* path = slot["path"].string();
    const auto* class_id = slot["classId"].string();
    return path && class_id ? *path + "|" + *class_id : "";
  }
  void publish() {
    auto chain = std::make_unique<EffectChain>();
    for (const auto& record : records_) chain->add(record.slot);
    bus_->setActive(chain->active(), chain->latencySamples());
    exchange_.publish(std::move(chain));
  }
  Json::Object slotStatus(const SlotRecord& record) {
    return Json::Object{{"slotId", record.id}, {"ok", true},
                        {"latencySamples", record.slot->latencySamples()},
                        {"hasEditor", record.vst ? record.vst->hasEditor() : false}};
  }
  void setChain(const Json& command) {
    const auto* slots = command["slots"].array();
    if (!slots || slots->size() > kMaximumSlots) {
      reply(command, {{"ok", false}, {"error", "Invalid effect chain"}});
      return;
    }
    std::vector<SlotRecord> next;
    Json::Array statuses;
    for (const auto& slot : *slots) {
      const auto* id = slot["slotId"].string();
      if (!id || std::ranges::find(next, *id, &SlotRecord::id) != next.end()) continue;
      const auto existing = std::ranges::find(records_, *id, &SlotRecord::id);
      if (existing != records_.end() && existing->identity == identityOf(slot)) {
        applyControls(*existing, slot);
        statuses.push_back(slotStatus(*existing));
        next.push_back(std::move(*existing));
        records_.erase(existing);
        continue;
      }
      std::string error;
      auto record = create(slot, *id, error);
      if (!record.slot) {
        statuses.push_back(Json::Object{{"slotId", *id}, {"ok", false}, {"error", error}});
        continue;
      }
      statuses.push_back(slotStatus(record));
      next.push_back(std::move(record));
    }
    // Records left in records_ are dropped. The chain the realtime thread runs
    // keeps their slots alive until collect(), which also runs on this thread.
    {
      PluginActivity activity("releasing plugins");
      for (auto& record : records_)
        if (record.vst) record.vst->closeEditor();
      records_ = std::move(next);
      publish();
    }
    reply(command, {{"ok", true}, {"slots", std::move(statuses)}});
  }
  void updateSlot(const Json& command) {
    withSlot(command, [&](SlotRecord& record) { applyControls(record, command); });
    if (const auto* chain = exchange_.latest()) bus_->setActive(chain->active(), chain->latencySamples());
  }
  void openEditor(const Json& command) {
    bool opened = false;
    withSlot(command, [&](SlotRecord& record) {
      if (!record.vst) return;
      const auto* title = command["title"].string();
      HWND owner = nullptr;
      if (const auto* handle = command["owner"].string()) {
        try { owner = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(std::stoull(*handle))); } catch (...) {}
        if (owner && !IsWindow(owner)) owner = nullptr;
      }
      PluginActivity activity(record.slot->label().c_str());
      opened = record.vst->openEditor(title ? *title : "Syrnike", owner);
      crash_reporting::rearm();
    });
    reply(command, {{"ok", opened}});
  }
  void getState(const Json& command) {
    std::optional<std::string> state;
    withSlot(command, [&](SlotRecord& record) {
      PluginActivity activity(record.slot->label().c_str());
      if (record.vst) state = encodeBase64(record.vst->saveState());
    });
    if (state) reply(command, {{"ok", true}, {"state", *state}});
    else reply(command, {{"ok", false}});
  }
  // Load per slot since the host started, and CPU of the whole process and of
  // the realtime thread since the previous stats request (percent of one core).
  void stats(const Json& command) {
    Json::Array slots;
    for (const auto& record : records_) {
      const auto load = record.slot->load().snapshot();
      slots.push_back(Json::Object{
          {"slotId", record.id},
          {"blocks", static_cast<double>(load.blocks)},
          {"averageUs", load.blocks ? static_cast<double>(load.total_ns) / static_cast<double>(load.blocks) / 1000.0
                                    : 0.0},
          {"p99Us", static_cast<double>(load.percentileNs(0.99)) / 1000.0},
          {"maxUs", static_cast<double>(load.max_ns) / 1000.0},
          {"overDeadline", static_cast<double>(overDeadline(load))},
      });
    }
    const auto now = Clock::now();
    const double wall_ms = std::chrono::duration<double, std::milli>(now - last_stats_).count();
    FILETIME created, exited, kernel, user;
    double process_ms = 0, audio_ms = 0;
    if (GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) process_ms = cpuMs(kernel, user);
    if (const HANDLE thread = audio_thread_.load(); thread && GetThreadTimes(thread, &created, &exited, &kernel, &user))
      audio_ms = cpuMs(kernel, user);
    const double process_percent = wall_ms > 0 ? (process_ms - last_process_ms_) / wall_ms * 100 : 0;
    const double audio_percent = wall_ms > 0 ? (audio_ms - last_audio_ms_) / wall_ms * 100 : 0;
    last_stats_ = now;
    last_process_ms_ = process_ms;
    last_audio_ms_ = audio_ms;
    PROCESS_MEMORY_COUNTERS_EX memory{sizeof(memory)};
    GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory));
    reply(command, {{"ok", true}, {"slots", std::move(slots)}, {"processCpuPercent", process_percent},
                    {"audioThreadCpuPercent", audio_percent},
                    {"privateMegabytes", static_cast<double>(memory.PrivateUsage) / (1024.0 * 1024.0)}});
  }
  // Blocks that alone used the whole bus deadline of the microphone DSP.
  static std::uint64_t overDeadline(const EffectLoad::Snapshot& load) {
    const auto first = static_cast<std::size_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(kEffectBusDeadline).count() / EffectLoad::kBucketNs);
    std::uint64_t count = 0;
    for (std::size_t index = first; index < EffectLoad::kBuckets; ++index) count += load.histogram[index];
    return count;
  }
  static double cpuMs(const FILETIME& kernel, const FILETIME& user) {
    const auto value = [](const FILETIME& time) {
      return (static_cast<std::uint64_t>(time.dwHighDateTime) << 32) | time.dwLowDateTime;
    };
    return static_cast<double>(value(kernel) + value(user)) / 10'000.0;
  }

  // A plugin that changed its latency or I/O is rebuilt from its own state.
  void restartPlugins() {
    bool changed = false;
    for (auto& record : records_) {
      if (!record.vst || !record.signals->restart.exchange(false)) continue;
      const auto state = record.vst->saveState();
      const auto separator = record.identity.find('|');
      const bool reopen = record.vst->editorOpen();
      PluginActivity activity(record.slot->label().c_str());
      try {
        auto effect = Vst3Effect::create(record.identity.substr(0, separator), record.identity.substr(separator + 1),
                                         &state, notifier(record.signals));
        auto* vst = effect.get();
        crash_reporting::rearm();
        auto slot = std::make_shared<EffectSlot>(std::move(effect), record.slot->mix(), record.slot->enabled(),
                                                 record.slot->label());
        record.vst->closeEditor();
        retired_slots_.push_back(std::exchange(record.slot, std::move(slot)));
        record.vst = vst;
        if (reopen) record.vst->openEditor(record.name.empty() ? "Syrnike" : record.name, nullptr);
        changed = true;
      } catch (const std::exception& failure) {
        output_.write(Json::Object{{"event", "slotFailed"}, {"slotId", record.id}, {"error", failure.what()}});
      }
    }
    if (!changed) return;
    publish();
    retired_slots_.clear();
  }

  Output& output_;
  std::unique_ptr<EffectBusServer> bus_;
  EffectChainExchange exchange_;
  std::vector<SlotRecord> records_;
  std::vector<std::shared_ptr<EffectSlot>> retired_slots_;
  std::thread audio_;
  std::atomic<HANDLE> audio_thread_{nullptr};
  std::atomic<bool> stopping_{false};
  Clock::time_point last_stats_ = Clock::now();
  double last_process_ms_ = 0, last_audio_ms_ = 0;
};

// Reads stdin lines on its own thread and wakes the UI thread for each one.
class InputReader {
 public:
  explicit InputReader(DWORD ui_thread) : ui_thread_(ui_thread) {
    thread_ = std::thread([this] { run(); });
  }
  ~InputReader() {
    CancelSynchronousIo(thread_.native_handle());
    if (thread_.joinable()) thread_.join();
  }
  std::deque<std::string> take(bool& closed) {
    std::lock_guard lock(mutex_);
    closed = closed_;
    return std::exchange(lines_, {});
  }
 private:
  void run() {
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    std::string pending;
    char buffer[64 * 1024];
    for (;;) {
      DWORD read = 0;
      if (!ReadFile(input, buffer, sizeof(buffer), &read, nullptr) || read == 0) break;
      pending.append(buffer, read);
      std::size_t start = 0;
      for (std::size_t end; (end = pending.find('\n', start)) != std::string::npos; start = end + 1) {
        std::lock_guard lock(mutex_);
        lines_.emplace_back(pending, start, end - start);
      }
      pending.erase(0, start);
      if (pending.size() > kMaximumLine) break;
      PostThreadMessageW(ui_thread_, kInputMessage, 0, 0);
    }
    {
      std::lock_guard lock(mutex_);
      closed_ = true;
    }
    PostThreadMessageW(ui_thread_, kInputMessage, 0, 0);
  }
  DWORD ui_thread_;
  std::mutex mutex_;
  std::deque<std::string> lines_;
  bool closed_ = false;
  std::thread thread_;
};

int serve(Output& output, const std::string& bus_id, DWORD parent_id) {
  auto bus = EffectBusServer::create(bus_id);
  if (!bus) {
    output.write(Json::Object{{"event", "failed"}, {"error", "The effect bus could not be created"}});
    return 2;
  }
  const HANDLE parent = parent_id ? OpenProcess(SYNCHRONIZE, FALSE, parent_id) : nullptr;
  // Create the UI thread message queue before the reader can post to it.
  MSG message;
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  Host host(output, std::move(bus));
  host.startAudio();
  InputReader reader(GetCurrentThreadId());
  output.write(Json::Object{{"event", "ready"}});
  const char* reason = nullptr;
  int code = 0;
  while (!reason) {
    const DWORD count = parent ? 1 : 0;
    const DWORD wait = MsgWaitForMultipleObjects(count, &parent, FALSE, 100, QS_ALLINPUT);
    if (parent && wait == WAIT_OBJECT_0) {
      reason = "parent_exited";
      code = 11;
      break;
    }
    while (!reason && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      // Only plugins post WM_QUIT (some do when their editor closes); the host
      // ends on its own protocol, never because a plugin asked the thread to.
      if (message.message == WM_QUIT) {
        output.write(Json::Object{{"event", "pluginQuitIgnored"}});
        continue;
      }
      if (message.message == kInputMessage && !message.hwnd) {
        bool closed = false;
        for (const auto& line : reader.take(closed)) {
          const auto command = Json::parse(line);
          if (!command || !command->isObject()) continue;
          const auto* type = (*command)["type"].string();
          if (type && *type == "shutdown") reason = "shutdown";
          else host.handle(*command);
        }
        if (closed && !reason) {
          reason = "stdin_closed";
          code = 10;
        }
        continue;
      }
      TranslateMessage(&message);
      PluginActivity activity("editor window message");
      DispatchMessageW(&message);
    }
    host.tick();
  }
  output.write(Json::Object{{"event", "exit"}, {"reason", reason}});
  host.stopAudio();
  host.release();
  if (parent) CloseHandle(parent);
  return code;
}

// Realtime load of one effect: 10 ms blocks of a voice-like signal paced on
// the frame clock, as the microphone DSP calls the host.
int bench(Output& output, const std::map<std::string, std::string>& options) {
  const auto target = options.at("--bench");
  double seconds = 10;
  if (const auto value = options.find("--seconds"); value != options.end()) {
    try { seconds = std::clamp(std::stod(value->second), 1.0, 600.0); } catch (...) {}
  }
  PROCESS_MEMORY_COUNTERS_EX memory{sizeof(memory)};
  GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory));
  const double memory_before = static_cast<double>(memory.PrivateUsage);
  const auto load_started = Clock::now();
  std::unique_ptr<AudioEffect> effect;
  try {
    if (target.starts_with("builtin:")) {
      effect = makeBuiltinEffect(target.substr(8));
      if (!effect) throw std::runtime_error("Unknown built-in effect");
    } else {
      const auto class_id = options.find("--class");
      if (class_id == options.end()) throw std::runtime_error("--class is required");
      PluginActivity activity(target.c_str());
      effect = Vst3Effect::create(target, class_id->second, nullptr, {});
      crash_reporting::rearm();
    }
  } catch (const std::exception& failure) {
    output.write(Json::Object{{"ok", false}, {"error", failure.what()}});
    return 1;
  }
  const double load_ms = std::chrono::duration<double, std::milli>(Clock::now() - load_started).count();
  EffectSlot slot(std::move(effect), 1.0f, true, target);

  DWORD task = 0;
  const HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
  const HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
  const auto blocks = static_cast<std::size_t>(seconds * 100);
  std::vector<double> durations;
  durations.reserve(blocks);
  const auto cpuNow = [] {
    FILETIME created, exited, kernel, user;
    GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user);
    const auto value = [](const FILETIME& time) {
      return (static_cast<std::uint64_t>(time.dwHighDateTime) << 32) | time.dwLowDateTime;
    };
    return static_cast<double>(value(kernel) + value(user)) / 10'000.0;
  };
  const double cpu_before = cpuNow();
  std::array<float, kEffectBusFrameSamples> frame{};
  std::uint32_t noise = 0x12345678;
  const auto started = Clock::now();
  for (std::size_t block = 0; block < blocks; ++block) {
    // Syllable-rate modulated harmonics plus a little noise, like speech.
    for (std::size_t index = 0; index < frame.size(); ++index) {
      const double time = static_cast<double>(block * frame.size() + index) / kEffectSampleRate;
      const double envelope = 0.5 + 0.5 * std::sin(2 * std::numbers::pi * 4 * time);
      double value = 0;
      for (int harmonic = 1; harmonic <= 8; ++harmonic)
        value += std::sin(2 * std::numbers::pi * 140 * harmonic * time) / harmonic;
      noise = noise * 1664525u + 1013904223u;
      frame[index] = static_cast<float>(0.15 * envelope * value + 0.01 * ((noise >> 8) / 8388608.0 - 1.0));
    }
    const auto begin = Clock::now();
    slot.process(frame.data(), frame.size());
    durations.push_back(std::chrono::duration<double, std::micro>(Clock::now() - begin).count());
    const auto next = started + std::chrono::milliseconds{10} * (block + 1);
    const auto wait = std::chrono::duration_cast<std::chrono::nanoseconds>(next - Clock::now()).count();
    if (wait > 0 && timer) {
      LARGE_INTEGER due;
      due.QuadPart = -static_cast<LONGLONG>(wait / 100);
      SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE);
      WaitForSingleObject(timer, INFINITE);
    }
  }
  const double wall_ms = std::chrono::duration<double, std::milli>(Clock::now() - started).count();
  const double cpu_ms = cpuNow() - cpu_before;
  if (timer) CloseHandle(timer);
  if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
  GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory));
  std::vector<double> sorted = durations;
  std::ranges::sort(sorted);
  const auto percentile = [&](double fraction) {
    return sorted[(std::min)(sorted.size() - 1, static_cast<std::size_t>(fraction * static_cast<double>(sorted.size())))];
  };
  double total = 0;
  for (const double value : durations) total += value;
  const auto deadline_us = static_cast<double>(
      std::chrono::duration_cast<std::chrono::microseconds>(kEffectBusDeadline).count());
  const auto over = std::ranges::count_if(durations, [&](double value) { return value >= deadline_us; });
  const double average = total / static_cast<double>(durations.size());
  output.write(Json::Object{
      {"ok", true}, {"target", target}, {"seconds", seconds}, {"loadMs", load_ms},
      {"latencySamples", slot.latencySamples()},
      {"averageUs", average}, {"p50Us", percentile(0.5)}, {"p99Us", percentile(0.99)}, {"maxUs", sorted.back()},
      {"overDeadline", static_cast<double>(over)},
      {"budgetPercent", average / 100.0},
      {"processCpuPercent", cpu_ms / wall_ms * 100.0},
      {"privateMegabytes", (static_cast<double>(memory.PrivateUsage) - memory_before) / (1024.0 * 1024.0)},
  });
  return 0;
}
}  // namespace

int wmain() {
  int count = 0;
  wchar_t** arguments = CommandLineToArgvW(GetCommandLineW(), &count);
  std::map<std::string, std::string> options;
  bool list_modules = false;
  for (int index = 1; index < count; ++index) {
    const auto name = narrow(arguments[index]);
    if (name == "--list-modules") list_modules = true;
    else if (index + 1 < count) options[name] = narrow(arguments[++index]);
  }
  LocalFree(arguments);
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  Output output;
  std::wstring dump_directory;
  if (const auto value = options.find("--crash-dir"); value != options.end())
    dump_directory.assign(value->second.begin(), value->second.end());
  crash_reporting::install(output.handle(), dump_directory);
  crash_reporting::markUiThread();
  if (FAILED(OleInitialize(nullptr))) return 3;
  // A catalog scan loads third-party modules that can take seconds each
  // (instruments especially). It must never compete with a call, so the whole
  // scan process runs below normal priority.
  if (list_modules || options.contains("--scan"))
    SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
  int result = 1;
  if (list_modules) {
    Json::Array paths;
    for (const auto& path : vst3ModulePaths()) paths.push_back(path);
    output.write(Json::Object{{"modules", std::move(paths)}});
    result = 0;
  } else if (const auto test = options.find("--crash-test"); test != options.end()) {
    // Verifies crash reporting end to end: a labelled fault on the UI thread.
    static std::string label;
    label = test->second;
    PluginActivity activity(label.c_str());
    volatile int* invalid = nullptr;
    *invalid = 1;
  } else if (options.contains("--bench")) {
    result = bench(output, options);
  } else if (const auto path = options.find("--scan"); path != options.end()) {
    result = scan(output, path->second);
  } else if (const auto bus = options.find("--bus"); bus != options.end() && validEffectBusId(bus->second)) {
    DWORD parent = 0;
    if (const auto value = options.find("--parent"); value != options.end()) {
      try { parent = static_cast<DWORD>(std::stoul(value->second)); } catch (...) {}
    }
    result = serve(output, bus->second, parent);
  }
  // Plugins may leave threads or globals behind; skip their static teardown.
  ExitProcess(static_cast<UINT>(result));
}
