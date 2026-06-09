#pragma once

#include "input_state.hpp"

#include <string>

namespace syrnike::hotkeys {

std::string jsonEscape(const std::string& value);
std::string eventToJson(const NativeInputEvent& event);

}  // namespace syrnike::hotkeys
