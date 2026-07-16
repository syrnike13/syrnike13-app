#include "input_state.hpp"

namespace syrnike::hotkeys {

std::optional<NativeInputEvent> InputState::applyDown(
  const std::string& source,
  const std::string& code,
  const std::string& label
) {
  const auto [_, inserted] = pressed_codes_.insert(code);
  if (!inserted) return std::nullopt;
  return event("inputDown", source, code, label);
}

std::optional<NativeInputEvent> InputState::applyUp(
  const std::string& source,
  const std::string& code,
  const std::string& label
) {
  const auto removed = pressed_codes_.erase(code);
  if (removed == 0) return std::nullopt;
  return event("inputUp", source, code, label);
}

void InputState::reset() {
  pressed_codes_.clear();
}

NativeInputEvent InputState::event(
  const std::string& type,
  const std::string& source,
  const std::string& code,
  const std::string& label
) const {
  return NativeInputEvent{
    type,
    source,
    code,
    label,
    std::vector<std::string>(pressed_codes_.begin(), pressed_codes_.end()),
  };
}

}  // namespace syrnike::hotkeys
