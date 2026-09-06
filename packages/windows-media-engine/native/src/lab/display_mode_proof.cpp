#include <windows.h>
#include <array>
#include <charconv>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <utility>

namespace {
struct Topology {
  std::array<DISPLAYCONFIG_PATH_INFO, 64> paths{};
  std::array<DISPLAYCONFIG_MODE_INFO, 128> modes{};
  UINT32 path_count = 64, mode_count = 128;
  void read() {
    if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &path_count, paths.data(), &mode_count,
                           modes.data(), nullptr) != ERROR_SUCCESS)
      throw std::runtime_error("Active topology exceeds proof bounds or is unavailable");
  }
};
struct RestoreTopology {
  Topology original;
  bool changed = false;
  bool restore() noexcept {
    if (!changed) return true;
    if (SetDisplayConfig(original.path_count, original.paths.data(), original.mode_count,
                         original.modes.data(),
                         SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG) != ERROR_SUCCESS)
      return false;
    changed = false;
    return true;
  }
  ~RestoreTopology() {
    if (!restore()) std::cerr << "DISPLAY_TOPOLOGY_RESTORE_FAILED" << std::endl;
  }
};
bool modeMatches(const wchar_t* device, const DEVMODEW& expected) {
  DEVMODEW actual{};
  actual.dmSize = sizeof(actual);
  return EnumDisplaySettingsW(device, ENUM_CURRENT_SETTINGS, &actual) &&
         actual.dmPelsWidth == expected.dmPelsWidth &&
         actual.dmPelsHeight == expected.dmPelsHeight &&
         actual.dmDisplayFrequency == expected.dmDisplayFrequency &&
         actual.dmDisplayOrientation == expected.dmDisplayOrientation &&
         actual.dmPosition.x == expected.dmPosition.x &&
         actual.dmPosition.y == expected.dmPosition.y;
}
DISPLAYCONFIG_SOURCE_DEVICE_NAME sourceName(const DISPLAYCONFIG_PATH_INFO& path) {
  DISPLAYCONFIG_SOURCE_DEVICE_NAME name{};
  name.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
  name.header.size = sizeof(name);
  name.header.adapterId = path.sourceInfo.adapterId;
  name.header.id = path.sourceInfo.id;
  if (DisplayConfigGetDeviceInfo(&name.header) != ERROR_SUCCESS)
    throw std::runtime_error("Display source name unavailable");
  return name;
}
void disconnectOutput(const wchar_t* device) {
  RestoreTopology restore;
  restore.original.read();
  auto disabled = restore.original;
  std::array<DISPLAYCONFIG_SOURCE_DEVICE_NAME, 64> names{};
  std::array<DEVMODEW, 64> saved_modes{};
  unsigned removed = 0;
  for (UINT32 i = 0; i < disabled.path_count; ++i) {
    names[i] = sourceName(disabled.paths[i]);
    saved_modes[i].dmSize = sizeof(DEVMODEW);
    if (!EnumDisplaySettingsW(names[i].viewGdiDeviceName, ENUM_CURRENT_SETTINGS, &saved_modes[i]))
      throw std::runtime_error("Display mode snapshot unavailable");
    if (wcscmp(names[i].viewGdiDeviceName, device) == 0) {
      disabled.paths[i].flags &= ~DISPLAYCONFIG_PATH_ACTIVE;
      ++removed;
    }
  }
  if (removed != 1 || disabled.path_count <= 1 ||
      SetDisplayConfig(disabled.path_count, disabled.paths.data(), disabled.mode_count,
                       disabled.modes.data(),
                       SDC_VALIDATE | SDC_USE_SUPPLIED_DISPLAY_CONFIG) != ERROR_SUCCESS)
    throw std::runtime_error("Secondary output cannot be disabled independently");
  std::cout << "DISPLAY_PROOF_READY "
               "{\"operation\":\"output-disconnect\",\"physicalCable\":false,\"beforeActivePaths\":"
            << disabled.path_count << "}" << std::endl;
  std::this_thread::sleep_for(std::chrono::seconds{5});
  restore.changed = true;
  if (SetDisplayConfig(disabled.path_count, disabled.paths.data(), disabled.mode_count,
                       disabled.modes.data(),
                       SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG) != ERROR_SUCCESS)
    throw std::runtime_error("Output disconnect failed");
  Topology actual;
  actual.read();
  if (actual.path_count + 1 != restore.original.path_count)
    throw std::runtime_error("Output did not leave the active topology");
  for (UINT32 i = 0; i < actual.path_count; ++i)
    if (wcscmp(sourceName(actual.paths[i]).viewGdiDeviceName, device) == 0)
      throw std::runtime_error("Selected output remained active");
  for (UINT32 i = 0; i < restore.original.path_count; ++i)
    if (wcscmp(names[i].viewGdiDeviceName, device) != 0 &&
        !modeMatches(names[i].viewGdiDeviceName, saved_modes[i]))
      throw std::runtime_error("Disconnect changed another display's mode");
  std::cout << "DISPLAY_PROOF_CHANGED" << std::endl;
  std::this_thread::sleep_for(std::chrono::seconds{8});
  if (!restore.restore()) throw std::runtime_error("Output reconnect failed");
  Topology restored;
  restored.read();
  if (restored.path_count != restore.original.path_count)
    throw std::runtime_error("Restored topology has a different active path count");
  for (UINT32 i = 0; i < restore.original.path_count; ++i)
    if (!modeMatches(names[i].viewGdiDeviceName, saved_modes[i]))
      throw std::runtime_error("Output restoration changed a display mode or position");
  std::cout << "DISPLAY_PROOF_RESTORED" << std::endl;
}
struct Restore {
  wchar_t device[32]{};
  DEVMODEW original{};
  bool changed = false;
  bool restore() noexcept {
    if (!changed) return true;
    if (ChangeDisplaySettingsExW(device, &original, nullptr, 0, nullptr) != DISP_CHANGE_SUCCESSFUL)
      return false;
    changed = false;
    return true;
  }
  ~Restore() {
    if (changed && !restore()) std::cerr << "DISPLAY_RESTORE_FAILED" << std::endl;
  }
};
}  // namespace
int main(int argc, char** argv) {
  try {
    if (argc != 3)
      throw std::runtime_error(
          "Usage: display_mode_proof non-primary-monitor-index "
          "resolution|refresh|rotation|disconnect");
    int requested_index = -1;
    const std::string_view index_text(argv[1]), operation(argv[2]);
    const auto parsed =
        std::from_chars(index_text.data(), index_text.data() + index_text.size(), requested_index);
    if (parsed.ec != std::errc{} || parsed.ptr != index_text.data() + index_text.size() ||
        requested_index < 0)
      throw std::runtime_error("Invalid monitor index");
    DISPLAY_DEVICEW selected{};
    int attached_index = 0;
    bool found = false;
    for (DWORD index = 0;; ++index) {
      DISPLAY_DEVICEW display{};
      display.cb = sizeof(display);
      if (!EnumDisplayDevicesW(nullptr, index, &display, 0)) break;
      if (!(display.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP)) continue;
      if (attached_index++ == requested_index) {
        selected = display;
        found = true;
        break;
      }
    }
    if (!found || (selected.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE))
      throw std::runtime_error("Proof requires an existing non-primary display");
    if (operation == "disconnect") {
      disconnectOutput(selected.DeviceName);
      return 0;
    }
    Restore restore;
    wcscpy_s(restore.device, selected.DeviceName);
    restore.original.dmSize = sizeof(DEVMODEW);
    if (!EnumDisplaySettingsW(selected.DeviceName, ENUM_CURRENT_SETTINGS, &restore.original))
      throw std::runtime_error("Current mode unavailable");
    DEVMODEW candidate = restore.original;
    bool candidate_found = false;
    if (operation == "rotation") {
      candidate.dmDisplayOrientation = (candidate.dmDisplayOrientation + 1) % 4;
      std::swap(candidate.dmPelsWidth, candidate.dmPelsHeight);
      candidate.dmFields |= DM_DISPLAYORIENTATION | DM_PELSWIDTH | DM_PELSHEIGHT;
      candidate_found = true;
    } else if (operation == "resolution" || operation == "refresh") {
      for (DWORD index = 0;; ++index) {
        DEVMODEW mode{};
        mode.dmSize = sizeof(mode);
        if (!EnumDisplaySettingsW(selected.DeviceName, index, &mode)) break;
        if (mode.dmBitsPerPel != restore.original.dmBitsPerPel ||
            mode.dmDisplayOrientation != restore.original.dmDisplayOrientation)
          continue;
        const bool match =
            operation == "resolution"
                ? mode.dmPelsWidth == 1280 && mode.dmPelsHeight == 720 &&
                      (mode.dmPelsWidth != restore.original.dmPelsWidth ||
                       mode.dmPelsHeight != restore.original.dmPelsHeight)
                : mode.dmPelsWidth == restore.original.dmPelsWidth &&
                      mode.dmPelsHeight == restore.original.dmPelsHeight &&
                      mode.dmDisplayFrequency != restore.original.dmDisplayFrequency &&
                      mode.dmDisplayFrequency >= 50;
        if (!match) continue;
        candidate = mode;
        candidate.dmPosition = restore.original.dmPosition;
        candidate.dmFields |= DM_POSITION;
        candidate_found = true;
        break;
      }
    } else
      throw std::runtime_error("Unknown display proof operation");
    if (!candidate_found || ChangeDisplaySettingsExW(selected.DeviceName, &candidate, nullptr,
                                                     CDS_TEST, nullptr) != DISP_CHANGE_SUCCESSFUL)
      throw std::runtime_error("No supported alternate display mode for this proof");
    std::cout << "DISPLAY_PROOF_READY {\"operation\":\"" << operation
              << "\",\"beforeWidth\":" << restore.original.dmPelsWidth
              << ",\"beforeHeight\":" << restore.original.dmPelsHeight
              << ",\"beforeHz\":" << restore.original.dmDisplayFrequency
              << ",\"afterWidth\":" << candidate.dmPelsWidth
              << ",\"afterHeight\":" << candidate.dmPelsHeight
              << ",\"afterHz\":" << candidate.dmDisplayFrequency << "}" << std::endl;
    std::this_thread::sleep_for(std::chrono::seconds{5});
    if (ChangeDisplaySettingsExW(selected.DeviceName, &candidate, nullptr, 0, nullptr) !=
        DISP_CHANGE_SUCCESSFUL)
      throw std::runtime_error("Display mode change failed");
    restore.changed = true;
    std::cout << "DISPLAY_PROOF_CHANGED" << std::endl;
    std::this_thread::sleep_for(std::chrono::seconds{8});
    if (!restore.restore()) throw std::runtime_error("Display mode restoration failed");
    DEVMODEW actual{};
    actual.dmSize = sizeof(actual);
    if (!EnumDisplaySettingsW(selected.DeviceName, ENUM_CURRENT_SETTINGS, &actual) ||
        actual.dmPelsWidth != restore.original.dmPelsWidth ||
        actual.dmPelsHeight != restore.original.dmPelsHeight ||
        actual.dmDisplayFrequency != restore.original.dmDisplayFrequency ||
        actual.dmPosition.x != restore.original.dmPosition.x ||
        actual.dmPosition.y != restore.original.dmPosition.y ||
        actual.dmDisplayOrientation != restore.original.dmDisplayOrientation)
      throw std::runtime_error("Display mode restoration did not match the original");
    std::cout << "DISPLAY_PROOF_RESTORED" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
