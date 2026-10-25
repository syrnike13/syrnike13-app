#pragma once

#include "audio_plugins/effect_chain.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace syrnike::windows_media::audio_plugins {
struct Vst3PluginInfo {
  std::string path;
  std::string class_id;
  std::string name;
  std::string vendor;
  std::string version;
  std::string sub_categories;
};

// Installed .vst3 bundles in the standard Windows locations.
std::vector<std::string> vst3ModulePaths();
// Audio effect classes of one module. Loads the module: run it in a scan
// process, since a broken plugin can crash or hang while loading.
std::vector<Vst3PluginInfo> scanVst3Module(const std::string& path, std::string& error);

enum class Vst3Notice { edited, restart };

// One VST 3 audio effect. Everything except process() and latencySamples()
// runs on the host UI thread, which also owns the module.
class Vst3Effect final : public AudioEffect {
 public:
  using Notify = std::function<void(Vst3Notice)>;
  // Throws std::runtime_error with a user-facing reason.
  static std::unique_ptr<Vst3Effect> create(const std::string& path, const std::string& class_id,
                                            const std::vector<std::uint8_t>* state, Notify);
  ~Vst3Effect() override;
  void process(float* samples, std::size_t count) noexcept override;
  std::uint32_t latencySamples() const noexcept override { return latency_; }

  std::vector<std::uint8_t> saveState();
  // A plugin without an edit controller has no editor to open.
  bool hasEditor() const noexcept;
  // Owner is the app window, so the editor stays above it. Null for none.
  bool openEditor(const std::string& title, void* owner);
  void closeEditor();
  bool editorOpen() const noexcept;
  // Forwards parameter values the processor reported (meters, automation).
  void pumpOutputChanges();
  struct Impl;
 private:
  explicit Vst3Effect(std::unique_ptr<Impl>);
  std::unique_ptr<Impl> impl_;
  std::uint32_t latency_ = 0;
};
}  // namespace syrnike::windows_media::audio_plugins
