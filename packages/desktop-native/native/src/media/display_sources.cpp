#include "display_sources.hpp"

#include <dwmapi.h>
#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <cstring>
#include <cwctype>
#include <limits>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "display_source_visual_probe.hpp"
#include "display_source_window_probe.hpp"

namespace syrnike::desktop_native::media {
namespace {

struct ScreenSource {
  std::string id;
  std::string name;
  std::string type;
  std::string thumbnail_data_url;
  std::string app_icon_data_url;
  DWORD process_id = 0;
  std::string process_path;
  std::string classification;
  bool audio_available = false;
  std::string audio_mode;
};

struct MonitorEnumContext {
  DisplaySourceMetadataPage<ScreenSource>* page = nullptr;
  int monitor_index = 0;
};

struct WindowEnumContext {
  DisplaySourceMetadataPage<ScreenSource>* page = nullptr;
  HWND excluded_window = nullptr;
};

struct WindowDescriptor {
  HWND window = nullptr;
  RECT bounds{};
  std::wstring title;
};

struct MonitorVisualContext {
  std::string_view source_id;
  int monitor_index = 0;
  std::optional<ScreenSource> source;
  const std::atomic_bool* cancelled = nullptr;
};

DisplaySourceInfo toDisplaySourceInfo(ScreenSource source) {
  return DisplaySourceInfo{
      std::move(source.id),
      std::move(source.name),
      std::move(source.type),
      0,
      source.process_id,
      source.thumbnail_data_url.empty()
          ? std::nullopt
          : std::optional<std::string>(std::move(source.thumbnail_data_url)),
      source.app_icon_data_url.empty()
          ? std::nullopt
          : std::optional<std::string>(std::move(source.app_icon_data_url)),
      source.process_path.empty()
          ? std::nullopt
          : std::optional<std::string>(std::move(source.process_path)),
      std::move(source.classification),
      source.audio_available,
      std::move(source.audio_mode),
  };
}

const char kBase64Alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const std::vector<std::uint8_t>& bytes) {
  std::string out;
  out.reserve(((bytes.size() + 2) / 3) * 4);
  for (size_t i = 0; i < bytes.size(); i += 3) {
    const uint32_t b0 = bytes[i];
    const uint32_t b1 = i + 1 < bytes.size() ? bytes[i + 1] : 0;
    const uint32_t b2 = i + 2 < bytes.size() ? bytes[i + 2] : 0;
    const uint32_t packed = (b0 << 16) | (b1 << 8) | b2;
    out.push_back(kBase64Alphabet[(packed >> 18) & 0x3F]);
    out.push_back(kBase64Alphabet[(packed >> 12) & 0x3F]);
    out.push_back(i + 1 < bytes.size() ? kBase64Alphabet[(packed >> 6) & 0x3F] : '=');
    out.push_back(i + 2 < bytes.size() ? kBase64Alphabet[packed & 0x3F] : '=');
  }
  return out;
}

void appendU16(std::vector<std::uint8_t>& bytes, std::uint16_t value) {
  bytes.push_back(static_cast<std::uint8_t>(value & 0xFF));
  bytes.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
}

void appendU32(std::vector<std::uint8_t>& bytes, std::uint32_t value) {
  bytes.push_back(static_cast<std::uint8_t>(value & 0xFF));
  bytes.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
  bytes.push_back(static_cast<std::uint8_t>((value >> 16) & 0xFF));
  bytes.push_back(static_cast<std::uint8_t>((value >> 24) & 0xFF));
}

std::string bmpDataUrl(const std::vector<std::uint8_t>& bgra, int width, int height) {
  if (bgra.empty() || width <= 0 || height <= 0) return {};

  constexpr std::uint32_t file_header_size = 14;
  constexpr std::uint32_t info_header_size = 40;
  const std::uint32_t pixel_bytes = static_cast<std::uint32_t>(bgra.size());
  const std::uint32_t data_offset = file_header_size + info_header_size;

  std::vector<std::uint8_t> bmp;
  bmp.reserve(data_offset + bgra.size());
  appendU16(bmp, 0x4D42);
  appendU32(bmp, data_offset + pixel_bytes);
  appendU16(bmp, 0);
  appendU16(bmp, 0);
  appendU32(bmp, data_offset);

  appendU32(bmp, info_header_size);
  appendU32(bmp, static_cast<std::uint32_t>(width));
  appendU32(bmp, static_cast<std::uint32_t>(-height));
  appendU16(bmp, 1);
  appendU16(bmp, 32);
  appendU32(bmp, BI_RGB);
  appendU32(bmp, pixel_bytes);
  appendU32(bmp, 0);
  appendU32(bmp, 0);
  appendU32(bmp, 0);
  appendU32(bmp, 0);
  bmp.insert(bmp.end(), bgra.begin(), bgra.end());
  return "data:image/bmp;base64," + base64Encode(bmp);
}

std::string captureThumbnailDataUrl(
    HWND hwnd,
    const RECT& rect,
    const std::atomic_bool* cancelled = nullptr) {
  if (cancelled && cancelled->load(std::memory_order_acquire)) return {};
  constexpr int thumb_width = 320;
  constexpr int thumb_height = 180;
  const int source_width = rect.right - rect.left;
  const int source_height = rect.bottom - rect.top;
  if (source_width <= 0 || source_height <= 0) return {};

  HDC source_dc = hwnd ? GetWindowDC(hwnd) : GetDC(nullptr);
  if (!source_dc) return {};

  HDC memory_dc = CreateCompatibleDC(source_dc);
  if (!memory_dc) {
    ReleaseDC(hwnd, source_dc);
    return {};
  }

  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = thumb_width;
  info.bmiHeader.biHeight = -thumb_height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;

  void* bits = nullptr;
  HBITMAP bitmap = CreateDIBSection(source_dc, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bitmap || !bits) {
    DeleteDC(memory_dc);
    ReleaseDC(hwnd, source_dc);
    return {};
  }

  HGDIOBJ old = SelectObject(memory_dc, bitmap);
  SetStretchBltMode(memory_dc, HALFTONE);
  const BOOL copied = StretchBlt(
      memory_dc,
      0,
      0,
      thumb_width,
      thumb_height,
      source_dc,
      hwnd ? 0 : rect.left,
      hwnd ? 0 : rect.top,
      source_width,
      source_height,
      SRCCOPY);

  std::string data_url;
  if (copied) {
    std::vector<std::uint8_t> bgra(static_cast<size_t>(thumb_width) * thumb_height * 4);
    std::memcpy(bgra.data(), bits, bgra.size());
    data_url = bmpDataUrl(bgra, thumb_width, thumb_height);
  }

  SelectObject(memory_dc, old);
  DeleteObject(bitmap);
  DeleteDC(memory_dc);
  ReleaseDC(hwnd, source_dc);
  if (cancelled && cancelled->load(std::memory_order_acquire)) return {};
  return data_url;
}

std::wstring processImagePath(DWORD process_id) {
  if (process_id == 0) return {};
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (!process) return {};

  wchar_t path[MAX_PATH]{};
  DWORD path_size = MAX_PATH;
  const BOOL got_path = QueryFullProcessImageNameW(process, 0, path, &path_size);
  CloseHandle(process);
  if (!got_path) return {};
  return std::wstring(path, path_size);
}

std::string iconDataUrl(HICON icon) {
  if (!icon) return {};

  constexpr int icon_size = 32;
  HDC screen_dc = GetDC(nullptr);
  if (!screen_dc) return {};

  HDC memory_dc = CreateCompatibleDC(screen_dc);
  if (!memory_dc) {
    ReleaseDC(nullptr, screen_dc);
    return {};
  }

  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = icon_size;
  info.bmiHeader.biHeight = -icon_size;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;

  void* bits = nullptr;
  HBITMAP bitmap = CreateDIBSection(screen_dc, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bitmap || !bits) {
    DeleteDC(memory_dc);
    ReleaseDC(nullptr, screen_dc);
    return {};
  }

  HGDIOBJ old = SelectObject(memory_dc, bitmap);
  RECT clear_rect{0, 0, icon_size, icon_size};
  FillRect(memory_dc, &clear_rect, reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
  const BOOL drawn = DrawIconEx(
      memory_dc,
      0,
      0,
      icon,
      icon_size,
      icon_size,
      0,
      nullptr,
      DI_NORMAL);

  std::string data_url;
  if (drawn) {
    std::vector<std::uint8_t> bgra(static_cast<size_t>(icon_size) * icon_size * 4);
    std::memcpy(bgra.data(), bits, bgra.size());
    data_url = bmpDataUrl(bgra, icon_size, icon_size);
  }

  SelectObject(memory_dc, old);
  DeleteObject(bitmap);
  DeleteDC(memory_dc);
  ReleaseDC(nullptr, screen_dc);
  return data_url;
}

std::string appIconDataUrl(
    HWND hwnd,
    DWORD process_id,
    const std::atomic_bool& cancelled) {
  if (cancelled.load(std::memory_order_acquire)) return {};
  const auto message_icon = queryWindowMessageIcon(
      [hwnd](std::uintptr_t icon_kind, std::chrono::milliseconds timeout) {
        DWORD_PTR result = 0;
        const LRESULT sent = SendMessageTimeoutW(
            hwnd,
            WM_GETICON,
            static_cast<WPARAM>(icon_kind),
            0,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            static_cast<UINT>(timeout.count()),
            &result);
        return WindowMessageIconResult{
            sent != 0, static_cast<std::uintptr_t>(result)};
      });
  HICON icon = reinterpret_cast<HICON>(message_icon);
  if (cancelled.load(std::memory_order_acquire)) return {};
  if (!icon) icon = reinterpret_cast<HICON>(GetClassLongPtrW(hwnd, GCLP_HICONSM));
  if (!icon) icon = reinterpret_cast<HICON>(GetClassLongPtrW(hwnd, GCLP_HICON));
  if (icon) return iconDataUrl(icon);

  if (cancelled.load(std::memory_order_acquire)) return {};
  const std::wstring path = processImagePath(process_id);
  if (path.empty()) return {};

  if (cancelled.load(std::memory_order_acquire)) return {};
  HICON small_icon = nullptr;
  HICON large_icon = nullptr;
  const UINT extracted = ExtractIconExW(path.c_str(), 0, &large_icon, &small_icon, 1);
  HICON extracted_icon = small_icon ? small_icon : large_icon;
  std::string data_url;
  if (extracted > 0 && extracted_icon) {
    data_url = iconDataUrl(extracted_icon);
  }
  if (small_icon) DestroyIcon(small_icon);
  if (large_icon) DestroyIcon(large_icon);
  if (cancelled.load(std::memory_order_acquire)) return {};
  return data_url;
}

std::string gameClassification(HWND hwnd, const RECT& rect, const std::wstring& process_path) {
  const LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
  const LONG_PTR ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if ((ex_style & WS_EX_TOOLWINDOW) != 0) return "window";
  if (process_path.empty()) return "window";

  std::wstring lower_path(process_path);
  for (wchar_t& ch : lower_path) {
    ch = static_cast<wchar_t>(towlower(ch));
  }
  if (lower_path.find(L"\\windows\\systemapps\\") != std::wstring::npos) return "window";
  if (lower_path.find(L"\\windows\\system32\\") != std::wstring::npos) return "window";
  if (lower_path.find(L"\\windows\\syswow64\\") != std::wstring::npos) return "window";

  const std::vector<std::wstring> game_path_markers = {
      L"\\steamapps\\common\\",
      L"\\epic games\\",
      L"\\gog games\\",
      L"\\gog galaxy\\games\\",
      L"\\xboxgames\\",
      L"\\riot games\\",
      L"\\battle.net\\",
      L"\\ubisoft game launcher\\games\\",
      L"\\ea games\\",
      L"\\origin games\\",
  };
  for (const auto& marker : game_path_markers) {
    if (lower_path.find(marker) != std::wstring::npos) return "game_path";
  }

  const bool popup = (style & WS_POPUP) != 0;
  const bool captionless = (style & WS_CAPTION) == 0;
  if (!popup && !captionless) return "window";

  HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) return "window";

  const int width = rect.right - rect.left;
  const int height = rect.bottom - rect.top;
  const int monitor_width = info.rcMonitor.right - info.rcMonitor.left;
  const int monitor_height = info.rcMonitor.bottom - info.rcMonitor.top;
  const long long area = static_cast<long long>(width) * height;
  const long long monitor_area = static_cast<long long>(monitor_width) * monitor_height;
  if (monitor_area <= 0 || area * 100 < monitor_area * 70) return "window";
  return "fullscreen_or_borderless";
}

bool isCloakedWindow(HWND hwnd) {
  DWORD cloaked = 0;
  const HRESULT hr = DwmGetWindowAttribute(
      hwnd,
      DWMWA_CLOAKED,
      &cloaked,
      sizeof(cloaked));
  return SUCCEEDED(hr) && cloaked != 0;
}

std::string toUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string out(size, '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), size, nullptr, nullptr);
  return out;
}

std::string monitorStableId(const MONITORINFOEXW& info) {
  DISPLAY_DEVICEW display{};
  display.cb = sizeof(display);
  std::wstring stable_id(info.szDevice);
  if (EnumDisplayDevicesW(info.szDevice, 0, &display, EDD_GET_DEVICE_INTERFACE_NAME) &&
      display.DeviceID[0] != L'\0') {
    stable_id = display.DeviceID;
  }
  return toUtf8(stable_id);
}

ScreenSource makeMonitorSource(const MONITORINFOEXW& info, int index) {
  const int width = info.rcMonitor.right - info.rcMonitor.left;
  const int height = info.rcMonitor.bottom - info.rcMonitor.top;
  std::ostringstream name;
  name << "Screen " << index << " (" << width << "x" << height << ")";

  return ScreenSource{
      "screen:" + monitorStableId(info),
      name.str(),
      "screen",
      "",
      "",
      0,
      "",
      "monitor",
      true,
      "system_exclude",
  };
}

std::optional<WindowDescriptor> describeWindow(HWND hwnd, HWND excluded_window) {
  const LONG_PTR ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  RECT rect{};
  DisplayWindowProbeFacts facts{
      IsWindowVisible(hwnd) != FALSE,
      GetAncestor(hwnd, GA_ROOT) == hwnd,
      excluded_window && hwnd == excluded_window,
      isCloakedWindow(hwnd),
      (ex_style & WS_EX_TOOLWINDOW) != 0,
      (ex_style & WS_EX_NOACTIVATE) != 0,
      GetWindowRect(hwnd, &rect) != FALSE,
      rect.right - rect.left,
      rect.bottom - rect.top,
      true,
  };
  if (!shouldIncludeDisplayWindow(facts)) return std::nullopt;

  wchar_t title[512]{};
  const int title_length = GetWindowTextW(hwnd, title, static_cast<int>(std::size(title)));
  facts.has_title = title_length > 0;
  if (!shouldIncludeDisplayWindow(facts)) return std::nullopt;
  return WindowDescriptor{hwnd, rect, std::wstring(title, title_length)};
}

ScreenSource makeWindowSource(const WindowDescriptor& descriptor) {
  DWORD process_id = 0;
  GetWindowThreadProcessId(descriptor.window, &process_id);
  const std::wstring image_path = processImagePath(process_id);
  const std::string classification =
      gameClassification(descriptor.window, descriptor.bounds, image_path);
  const bool game = classification != "window";

  return ScreenSource{
      (game ? "game:" : "window:") +
          std::to_string(reinterpret_cast<std::uintptr_t>(descriptor.window)),
      toUtf8(descriptor.title),
      game ? "game" : "window",
      {},
      {},
      process_id,
      toUtf8(image_path),
      classification,
      process_id != 0,
      process_id != 0 ? "process" : "none",
  };
}

struct ParsedWindowSource {
  HWND window = nullptr;
  std::string_view source_type;
};

std::optional<ParsedWindowSource> parseWindowSourceId(std::string_view source_id) {
  constexpr std::string_view window_prefix = "window:";
  constexpr std::string_view game_prefix = "game:";
  std::string_view digits;
  std::string_view source_type;
  if (source_id.starts_with(window_prefix)) {
    digits = source_id.substr(window_prefix.size());
    source_type = "window";
  } else if (source_id.starts_with(game_prefix)) {
    digits = source_id.substr(game_prefix.size());
    source_type = "game";
  } else {
    return std::nullopt;
  }

  std::uint64_t handle_value = 0;
  const auto parsed = std::from_chars(
      digits.data(), digits.data() + digits.size(), handle_value);
  if (digits.empty() || parsed.ec != std::errc{} ||
      parsed.ptr != digits.data() + digits.size() || handle_value == 0 ||
      handle_value > std::numeric_limits<std::uintptr_t>::max()) {
    return std::nullopt;
  }
  return ParsedWindowSource{
      reinterpret_cast<HWND>(static_cast<std::uintptr_t>(handle_value)),
      source_type,
  };
}

BOOL CALLBACK enumMonitorMetadataProc(HMONITOR monitor, HDC, LPRECT, LPARAM data) {
  auto* context = reinterpret_cast<MonitorEnumContext*>(data);
  if (!context || !context->page) return FALSE;

  MONITORINFOEXW info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) return TRUE;
  ++context->monitor_index;
  return context->page->visit([&] {
    return makeMonitorSource(info, context->monitor_index);
  }) ? TRUE : FALSE;
}

BOOL CALLBACK enumWindowMetadataProc(HWND hwnd, LPARAM data) {
  auto* context = reinterpret_cast<WindowEnumContext*>(data);
  if (!context || !context->page) return FALSE;
  const auto descriptor = describeWindow(hwnd, context->excluded_window);
  if (!descriptor) return TRUE;
  return context->page->visit([&] {
    return makeWindowSource(*descriptor);
  }) ? TRUE : FALSE;
}

BOOL CALLBACK enumMonitorVisualProc(HMONITOR monitor, HDC, LPRECT, LPARAM data) {
  auto* context = reinterpret_cast<MonitorVisualContext*>(data);
  if (!context || (context->cancelled &&
                   context->cancelled->load(std::memory_order_acquire))) {
    return FALSE;
  }

  MONITORINFOEXW info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) return TRUE;
  ++context->monitor_index;
  auto source = makeMonitorSource(info, context->monitor_index);
  if (source.id != context->source_id) return TRUE;
  source.thumbnail_data_url =
      captureThumbnailDataUrl(nullptr, info.rcMonitor, context->cancelled);
  context->source = std::move(source);
  return FALSE;
}

std::optional<ScreenSource> probeVisualSource(
    std::string_view source_id,
    std::uint64_t excluded_window_handle,
    const std::atomic_bool& cancelled) {
  if (cancelled.load(std::memory_order_acquire)) return std::nullopt;
  if (source_id.starts_with("screen:")) {
    MonitorVisualContext context{source_id, 0, std::nullopt, &cancelled};
    EnumDisplayMonitors(
        nullptr,
        nullptr,
        enumMonitorVisualProc,
        reinterpret_cast<LPARAM>(&context));
    if (cancelled.load(std::memory_order_acquire)) return std::nullopt;
    return std::move(context.source);
  }

  const auto parsed = parseWindowSourceId(source_id);
  if (!parsed) return std::nullopt;
  const auto descriptor = describeWindow(
      parsed->window,
      reinterpret_cast<HWND>(static_cast<std::uintptr_t>(excluded_window_handle)));
  if (!descriptor || cancelled.load(std::memory_order_acquire)) {
    return std::nullopt;
  }
  auto candidate = makeWindowSource(*descriptor);
  if (candidate.type != parsed->source_type || candidate.id != source_id) {
    return std::nullopt;
  }
  candidate.thumbnail_data_url = captureThumbnailDataUrl(
      descriptor->window, descriptor->bounds, &cancelled);
  if (cancelled.load(std::memory_order_acquire)) return std::nullopt;
  candidate.app_icon_data_url =
      appIconDataUrl(descriptor->window, candidate.process_id, cancelled);
  if (cancelled.load(std::memory_order_acquire)) return std::nullopt;
  return candidate;
}

CleanupSupervisor& displaySourceVisualProbeSupervisor() {
  static auto* supervisor = new CleanupSupervisor({
      kDisplaySourceVisualProbeConcurrency,
      kDisplaySourceVisualProbeOwnershipCapacity,
  });
  return *supervisor;
}

DisplaySourceVisualProbeAdmission& displaySourceVisualProbeAdmission() {
  static auto* admission = new DisplaySourceVisualProbeAdmission(
      kDisplaySourceVisualProbeConcurrency);
  return *admission;
}

}  // namespace

bool DisplaySourceService::beginEnumeration(std::string enumeration_id) {
  return fence_.begin(std::move(enumeration_id));
}

void DisplaySourceService::cancelEnumeration(std::string_view enumeration_id) {
  fence_.cancel(enumeration_id);
}

void DisplaySourceService::shutdown() {
  fence_.shutdown();
}

std::vector<DisplaySourceInfo> DisplaySourceService::metadataPage(
    std::string_view enumeration_id,
    std::uint64_t page,
    std::uint64_t excluded_window_handle) {
  if (!fence_.isCurrent(enumeration_id)) return {};
  const auto page_index = static_cast<std::size_t>(std::min<std::uint64_t>(
      page, std::numeric_limits<std::size_t>::max()));
  DisplaySourceMetadataPage<ScreenSource> metadata(page_index);
  MonitorEnumContext monitor_context{&metadata};
  EnumDisplayMonitors(
      nullptr,
      nullptr,
      enumMonitorMetadataProc,
      reinterpret_cast<LPARAM>(&monitor_context));
  WindowEnumContext window_context{
      &metadata,
      reinterpret_cast<HWND>(static_cast<std::uintptr_t>(excluded_window_handle)),
  };
  if (!metadata.full()) {
    EnumWindows(enumWindowMetadataProc, reinterpret_cast<LPARAM>(&window_context));
  }
  if (!fence_.isCurrent(enumeration_id)) return {};

  auto sources = std::move(metadata).release();
  std::vector<DisplaySourceInfo> result;
  result.reserve(sources.size());
  for (auto& source : sources) {
    result.push_back(toDisplaySourceInfo(std::move(source)));
  }
  return result;
}

std::vector<DisplaySourceInfo> DisplaySourceService::visual(
    std::string_view enumeration_id,
    std::string_view source_id,
    std::uint64_t excluded_window_handle) {
  if (!fence_.isCurrent(enumeration_id) || source_id.empty()) return {};

  const auto owned_enumeration_id = std::string(enumeration_id);
  const auto owned_source_id = std::string(source_id);
  auto attempt = DisplaySourceVisualProbeAttempt<ScreenSource>::start(
      displaySourceVisualProbeSupervisor(),
      displaySourceVisualProbeAdmission(),
      [owned_source_id,
       excluded_window_handle](const std::atomic_bool& cancelled) {
        return probeVisualSource(
            owned_source_id, excluded_window_handle, cancelled);
      });
  if (!attempt) return {};
  auto source = attempt->waitUntil(
      std::chrono::steady_clock::now() + kDisplaySourceVisualProbeDeadline,
      [&] { return fence_.isCurrent(owned_enumeration_id); });
  if (!source) return {};
  std::vector<DisplaySourceInfo> result;
  result.reserve(1);
  result.push_back(toDisplaySourceInfo(std::move(*source)));
  return result;
}

}  // namespace syrnike::desktop_native::media
