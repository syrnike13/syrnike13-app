#pragma once

#include <cstdint>
#include <string>

namespace syrnike::hotkeys {

constexpr std::uint32_t kLlkhfExtended = 0x00000001;
constexpr std::uint32_t kLlkhfLowerIlInjected = 0x00000002;
constexpr std::uint32_t kLlkhfInjected = 0x00000010;
constexpr std::uint32_t kLlmhfInjected = 0x00000001;
constexpr std::uint32_t kLlmhfLowerIlInjected = 0x00000002;

bool isInjectedKeyEvent(std::uint32_t flags);
bool isInjectedMouseEvent(std::uint32_t flags);
std::string keyboardCode(std::uint32_t vk_code, std::uint32_t scan_code, std::uint32_t flags);
std::string labelForCode(const std::string& code, std::uint32_t vk_code);

}  // namespace syrnike::hotkeys
