#pragma once

#include <optional>
#include <set>
#include <string>
#include <vector>

namespace syrnike::hotkeys {

struct NativeInputEvent {
  std::string type;
  std::string source;
  std::string code;
  std::string label;
  std::vector<std::string> pressed_codes;
};

class InputState {
 public:
  std::optional<NativeInputEvent> applyDown(
    const std::string& source,
    const std::string& code,
    const std::string& label
  );

  std::optional<NativeInputEvent> applyUp(
    const std::string& source,
    const std::string& code,
    const std::string& label
  );

  void reset();

 private:
  std::set<std::string> pressed_codes_;

  NativeInputEvent event(
    const std::string& type,
    const std::string& source,
    const std::string& code,
    const std::string& label
  ) const;
};

}  // namespace syrnike::hotkeys
