#include "input_state.hpp"
#include "key_codes.hpp"
#include "protocol.hpp"

#include <stdexcept>
#include <string>
#include <vector>

namespace {

void expect(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

template <typename T>
void expectEqual(const T& actual, const T& expected, const std::string& message) {
  if (actual != expected) {
    throw std::runtime_error(message);
  }
}

void left_and_right_control_are_distinct() {
  using namespace syrnike::hotkeys;

  expectEqual(keyboardCode(0x11, 0x1d, 0), std::string("ControlLeft"),
              "plain control scan code should map to left control");
  expectEqual(keyboardCode(0x11, 0x1d, kLlkhfExtended), std::string("ControlRight"),
              "extended control scan code should map to right control");
}

void releasing_one_modifier_keeps_the_other_pressed() {
  using namespace syrnike::hotkeys;

  InputState state;
  const auto left_down = state.applyDown("keyboard", "ControlLeft", "Left Ctrl");
  const auto right_down = state.applyDown("keyboard", "ControlRight", "Right Ctrl");
  const auto right_up = state.applyUp("keyboard", "ControlRight", "Right Ctrl");

  expect(left_down.has_value(), "left control down should emit");
  expect(right_down.has_value(), "right control down should emit");
  expect(right_up.has_value(), "right control up should emit");
  expectEqual(right_up->pressed_codes, std::vector<std::string>{"ControlLeft"},
              "left control should remain pressed after right control is released");
}

void autorepeat_does_not_emit_a_second_down() {
  using namespace syrnike::hotkeys;

  InputState state;
  const auto first_down = state.applyDown("keyboard", "KeyM", "M");
  const auto repeat_down = state.applyDown("keyboard", "KeyM", "M");

  expect(first_down.has_value(), "first key down should emit");
  expect(!repeat_down.has_value(), "repeated key down should be ignored");
}

void injected_key_events_are_ignored() {
  using namespace syrnike::hotkeys;

  expect(isInjectedKeyEvent(kLlkhfInjected), "injected event should be ignored");
  expect(isInjectedKeyEvent(kLlkhfLowerIlInjected), "lower integrity injected event should be ignored");
  expect(!isInjectedKeyEvent(0), "ordinary key event should not be treated as injected");
}

void injected_mouse_events_are_ignored() {
  using namespace syrnike::hotkeys;

  expect(isInjectedMouseEvent(kLlmhfInjected), "injected mouse event should be ignored");
  expect(isInjectedMouseEvent(kLlmhfLowerIlInjected), "lower integrity injected mouse event should be ignored");
  expect(!isInjectedMouseEvent(0), "ordinary mouse event should not be treated as injected");
}

void mouse_buttons_update_pressed_codes() {
  using namespace syrnike::hotkeys;

  InputState state;
  const auto mouse5_down = state.applyDown("mouse", "Mouse5", "Mouse5");
  const auto mouse4_down = state.applyDown("mouse", "Mouse4", "Mouse4");
  const auto mouse5_up = state.applyUp("mouse", "Mouse5", "Mouse5");

  expect(mouse5_down.has_value(), "mouse5 down should emit");
  expect(mouse4_down.has_value(), "mouse4 down should emit");
  expect(mouse5_up.has_value(), "mouse5 up should emit");
  expectEqual(mouse5_up->pressed_codes, std::vector<std::string>{"Mouse4"},
              "mouse4 should remain pressed after mouse5 is released");
}

void events_are_serialized_as_ndjson_payloads() {
  using namespace syrnike::hotkeys;

  NativeInputEvent event;
  event.type = "inputDown";
  event.source = "keyboard";
  event.code = "ControlRight";
  event.label = "Right Ctrl";
  event.pressed_codes = {"ControlRight", "KeyM"};

  expectEqual(
    eventToJson(event),
    std::string("{\"type\":\"inputDown\",\"source\":\"keyboard\",\"code\":\"ControlRight\",\"label\":\"Right Ctrl\",\"pressedCodes\":[\"ControlRight\",\"KeyM\"]}"),
    "event JSON should match the desktop parser contract");
}

}  // namespace

int main() {
  using TestFn = void (*)();
  TestFn tests[] = {
    left_and_right_control_are_distinct,
    releasing_one_modifier_keeps_the_other_pressed,
    autorepeat_does_not_emit_a_second_down,
    injected_key_events_are_ignored,
    injected_mouse_events_are_ignored,
    mouse_buttons_update_pressed_codes,
    events_are_serialized_as_ndjson_payloads,
  };

  for (const auto test : tests) {
    test();
  }

  return 0;
}
