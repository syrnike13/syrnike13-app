#include "runtime_config.hpp"

#include <mutex>

namespace syrnike::voice {
namespace {

std::mutex g_config_mutex;
RuntimeConfig g_config;

}  // namespace

std::atomic<bool> g_running{true};

RuntimeConfig readRuntimeConfig() {
  std::lock_guard<std::mutex> lock(g_config_mutex);
  return g_config;
}

void updateRuntimeConfig(const StartCommand& command) {
  std::lock_guard<std::mutex> lock(g_config_mutex);
  g_config.input_volume = command.input_volume;
  // Temporarily disabled while the native gate is being reworked.
  g_config.voice_gate_enabled = false;
  g_config.voice_gate_threshold_db = command.voice_gate_threshold_db;
}

}  // namespace syrnike::voice
