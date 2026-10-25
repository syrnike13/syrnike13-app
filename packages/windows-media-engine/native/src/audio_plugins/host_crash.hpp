#pragma once

#include "audio_plugins/effect_chain.hpp"

#include <string>

namespace syrnike::windows_media::audio_plugins {
// Process-wide crash reporting for the plugin host. On an unhandled exception
// it writes one {"event":"crash",...} line to the protocol handle and, when a
// directory is given, a minidump; then the process ends with the exception
// code. Plugins often install their own filter, so call rearm() after loading
// one. Fast-fail aborts bypass every filter; Electron still sees their code.
namespace crash_reporting {
void install(void* protocol_handle, std::wstring dump_directory);
void rearm() noexcept;
// Names the realtime thread in reports ("audio"); others are "ui" or "other".
void markAudioThread() noexcept;
void markUiThread() noexcept;
}  // namespace crash_reporting
}  // namespace syrnike::windows_media::audio_plugins
