// Drives the real plugin host process over its stdio protocol and effect bus.
// Set SYRNIKE_TEST_VST3_PATH and SYRNIKE_TEST_VST3_CLASS to also load an
// installed VST 3 effect.
#include "audio_plugins/effect_bus.hpp"
#include "audio_plugins/json.hpp"

#include <windows.h>
#include <chrono>
#include <cmath>
#include <optional>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

using namespace syrnike::windows_media::audio_plugins;
namespace {
using Clock = std::chrono::steady_clock;
using Samples = std::array<std::int16_t, kEffectBusFrameSamples>;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }

class HostProcess {
 public:
  HostProcess(const std::filesystem::path& executable, const std::string& bus) {
    SECURITY_ATTRIBUTES inherit{sizeof(inherit), nullptr, TRUE};
    HANDLE child_in = nullptr, child_out = nullptr;
    require(CreatePipe(&child_in, &input_, &inherit, 0) && CreatePipe(&output_, &child_out, &inherit, 0),
            "Pipe creation failed");
    SetHandleInformation(input_, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(output_, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW startup{sizeof(startup)};
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = child_in;
    startup.hStdOutput = child_out;
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    std::wstring command = L"\"" + executable.wstring() + L"\" --bus " + std::wstring(bus.begin(), bus.end()) +
        L" --parent " + std::to_wstring(GetCurrentProcessId());
    require(CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr,
                           &startup, &process_), "Host process did not start");
    CloseHandle(child_in);
    CloseHandle(child_out);
  }
  ~HostProcess() {
    TerminateProcess(process_.hProcess, 1);
    CloseHandle(process_.hProcess);
    CloseHandle(process_.hThread);
    CloseHandle(input_);
    CloseHandle(output_);
  }
  void send(const Json& command) {
    auto line = command.dump() + "\n";
    DWORD written = 0;
    require(WriteFile(input_, line.data(), static_cast<DWORD>(line.size()), &written, nullptr), "Write failed");
  }
  Json receive(std::chrono::milliseconds timeout = std::chrono::milliseconds{15000}) {
    const auto deadline = Clock::now() + timeout;
    for (;;) {
      if (const auto end = buffer_.find('\n'); end != std::string::npos) {
        const auto line = buffer_.substr(0, end);
        buffer_.erase(0, end + 1);
        auto value = Json::parse(line);
        require(value.has_value(), "Host wrote invalid JSON");
        return *value;
      }
      DWORD available = 0;
      require(PeekNamedPipe(output_, nullptr, 0, nullptr, &available, nullptr), "Host output closed");
      if (!available) {
        require(Clock::now() < deadline, "Host did not answer");
        std::this_thread::sleep_for(std::chrono::milliseconds{5});
        continue;
      }
      std::string chunk(available, '\0');
      DWORD read = 0;
      require(ReadFile(output_, chunk.data(), available, &read, nullptr), "Read failed");
      buffer_.append(chunk, 0, read);
    }
  }
  Json reply(const Json& command) {
    send(command);
    for (;;) {
      auto value = receive();
      if (const auto* type = value["type"].string(); type && *type == "reply") return value;
    }
  }
  DWORD wait(DWORD milliseconds) {
    if (WaitForSingleObject(process_.hProcess, milliseconds) != WAIT_OBJECT_0) return STILL_ACTIVE;
    DWORD code = 0;
    GetExitCodeProcess(process_.hProcess, &code);
    return code;
  }
  void kill() { TerminateProcess(process_.hProcess, 9); WaitForSingleObject(process_.hProcess, 5000); }
 private:
  HANDLE input_ = nullptr, output_ = nullptr;
  PROCESS_INFORMATION process_{};
  std::string buffer_;
};

Samples tone(std::size_t block, float frequency, float amplitude = 8000) {
  Samples samples;
  for (std::size_t index = 0; index < samples.size(); ++index)
    samples[index] = static_cast<std::int16_t>(amplitude * std::sin(
        2.0f * 3.14159265f * frequency * static_cast<float>(block * samples.size() + index) / 48'000.0f));
  return samples;
}
std::optional<std::string> environment(const char* name) {
  char value[1024];
  const DWORD size = GetEnvironmentVariableA(name, value, sizeof(value));
  if (!size || size >= sizeof(value)) return std::nullopt;
  return std::string(value, size);
}
double rms(const Samples& samples) {
  double energy = 0;
  for (auto value : samples) energy += static_cast<double>(value) * value;
  return std::sqrt(energy / samples.size());
}
Json builtinSlot(const char* id, const char* builtin, double mix, Json::Object params = {}) {
  return Json::Object{{"slotId", id}, {"kind", "builtin"}, {"builtin", builtin}, {"mix", mix},
                      {"enabled", true}, {"params", std::move(params)}};
}
// Process until the 20 ms mix ramps have settled, return the last frame.
Samples settle(EffectBusClient& client, float frequency, bool expect_processed = true) {
  Samples samples{};
  for (std::size_t block = 0; block < 12; ++block) {
    samples = tone(block, frequency);
    require(client.process(samples) == expect_processed, "Unexpected bus processing state");
  }
  return samples;
}
}  // namespace

int main(int, char** argv) {
  try {
    const auto host_path = std::filesystem::path(argv[0]).parent_path() / "syrnike_audio_plugin_host.exe";
    const auto bus = "host-test-" + std::to_string(GetCurrentProcessId());
    HostProcess host(host_path, bus);
    const auto ready = host.receive();
    require(ready["event"].string() && *ready["event"].string() == "ready", "Host did not report ready");
    auto client = EffectBusClient::open(bus);
    require(client != nullptr, "Effect bus did not open");

    // An empty host is inactive: frames stay dry without a round trip.
    auto dry = tone(0, 100);
    require(!client->process(dry) && dry == tone(0, 100), "Empty host touched audio");

    auto result = host.reply(Json::Object{{"type", "setChain"}, {"requestId", 1}, {"slots", Json::Array{
        builtinSlot("bass", "eq", 1.0, {{"lowGainDb", 12.0}}),
        Json::Object{{"slotId", "bad"}, {"kind", "builtin"}, {"builtin", "missing"}}}}});
    const auto* statuses = result["slots"].array();
    require(result["ok"].boolean().value_or(false) && statuses && statuses->size() == 2, "setChain reply");
    require((*statuses)[0]["ok"].boolean().value_or(false), "Builtin slot failed");
    require(!(*statuses)[1]["ok"].boolean().value_or(true) && (*statuses)[1]["error"].string(),
            "Unknown builtin did not fail alone");
    const auto boosted = settle(*client, 100);
    // +12 dB shelf at 120 Hz is about +7.8 dB at 100 Hz.
    require(rms(boosted) > rms(tone(11, 100)) * 2.2, "Low shelf did not boost the voice");

    // Mix 0 fades back to the untouched dry frame.
    host.send(Json::Object{{"type", "updateSlot"}, {"slotId", "bass"}, {"mix", 0.0}});
    std::this_thread::sleep_for(std::chrono::milliseconds{50});
    require(settle(*client, 100) == tone(11, 100), "Zero mix did not return the dry voice");

    // A reorder keeps the existing slot; disabling every slot deactivates the bus.
    result = host.reply(Json::Object{{"type", "setChain"}, {"requestId", 2}, {"slots", Json::Array{
        builtinSlot("echo", "echo", 0.3), builtinSlot("bass", "eq", 1.0, {{"lowGainDb", 12.0}})}}});
    require(result["ok"].boolean().value_or(false), "Second setChain failed");
    std::this_thread::sleep_for(std::chrono::milliseconds{50});
    settle(*client, 100);
    host.reply(Json::Object{{"type", "setChain"}, {"requestId", 3}, {"slots", Json::Array{}}});
    std::this_thread::sleep_for(std::chrono::milliseconds{50});
    dry = tone(0, 100);
    require(!client->process(dry) && dry == tone(0, 100), "Empty chain stayed active");

    if (const auto path = environment("SYRNIKE_TEST_VST3_PATH")) {
      const auto class_id = environment("SYRNIKE_TEST_VST3_CLASS");
      require(class_id.has_value(), "SYRNIKE_TEST_VST3_CLASS is required with a VST 3 path");
      result = host.reply(Json::Object{{"type", "setChain"}, {"requestId", 4}, {"slots", Json::Array{
          Json::Object{{"slotId", "vst"}, {"kind", "vst3"}, {"path", *path}, {"classId", *class_id},
                       {"mix", 1.0}, {"enabled", true}}}}});
      statuses = result["slots"].array();
      require(statuses && (*statuses)[0]["ok"].boolean().value_or(false), "VST 3 effect failed to load");
      std::this_thread::sleep_for(std::chrono::milliseconds{100});
      for (std::size_t block = 0; block < 100; ++block) {
        auto samples = tone(block, 440);
        client->process(samples);
      }
      const auto state = host.reply(Json::Object{{"type", "getState"}, {"requestId", 5}, {"slotId", "vst"}});
      require(state["ok"].boolean().value_or(false) && state["state"].string() && !state["state"].string()->empty(),
              "VST 3 state was not saved");
      std::cout << "vst3 processed " << client->stats().processed << " frames, " << client->stats().timeouts
                << " timeouts\n";
    }

    // A dead host leaves the voice dry within one deadline and never blocks.
    host.reply(Json::Object{{"type", "setChain"}, {"requestId", 6}, {"slots", Json::Array{
        builtinSlot("bass", "eq", 1.0, {{"lowGainDb", 12.0}})}}});
    std::this_thread::sleep_for(std::chrono::milliseconds{50});
    settle(*client, 100);
    host.kill();
    const auto started = Clock::now();
    for (std::size_t block = 0; block < 20; ++block) {
      auto samples = tone(block, 100);
      require(!client->process(samples) && samples == tone(block, 100), "Dead host altered audio");
    }
    require(Clock::now() - started < std::chrono::milliseconds{100}, "Dead host stalled the DSP");

    HostProcess second(host_path, bus + "-b");
    second.receive();
    second.send(Json::Object{{"type", "shutdown"}});
    require(second.wait(5000) == 0, "Host did not shut down cleanly");
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
  std::cout << "audio plugin host ok\n";
  return 0;
}
