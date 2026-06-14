# Windows Screen Capture Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows native screen sharing stable at the requested quality, including 1080p60, without game injection and without changing 60 FPS presets to 30 FPS.

**Architecture:** Keep the capture system on public Windows APIs: Windows Graphics Capture for windows/games as it works today, DXGI output duplication for monitor capture, and LiveKit C++ for publishing. Split correctness, scheduling, GPU readback, and diagnostics into explicit units so frame starvation, resize/crop bugs, and recovery paths are observable and recoverable without changing fullscreen game behavior.

**Tech Stack:** C++20, Win32, D3D11, DXGI 1.2 Output Duplication, Windows.Graphics.Capture, Electron IPC, React, LiveKit C++ SDK, Vitest, CTest.

---

## Non-Negotiable Constraints

- Do not inject DLLs or hooks into games.
- Do not add special fullscreen game support in this iteration.
- Do not block fullscreen games; leave their current best-effort behavior intact.
- Do not lower the 60 FPS quality preset to 30 FPS.
- Do not hide overload by silently downgrading resolution, bitrate, or target FPS.
- Do keep streams real-time: if publishing cannot keep up, drop stale queued frames instead of building latency.
- Do expose diagnostics so we know whether the bottleneck is capture, GPU readback, encode, publish, or network.

## References

- Discord documents WGC plus a separate advanced capture path, and says WGC cannot capture full screen exclusive apps: https://support.discord.com/hc/en-us/articles/9410427556375--Windows-Capturing-Application-Window-for-Screen-Share-and-Go-Live
- Windows Graphics Capture frame pool surfaces are fixed to the frame pool size; larger content is clipped until the pool is recreated: https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture
- `Direct3D11CaptureFramePool.Recreate` exists specifically for rebuilding the pool with new inputs: https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool
- `IDXGIOutputDuplication::AcquireNextFrame` can return access lost and must be handled by rebuilding duplication: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-acquirenextframe
- `IDXGIDevice::SetGPUThreadPriority` can raise GPU scheduling priority, but Microsoft warns it must be profiled: https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgidevice-setgputhreadpriority
- MMCSS has built-in task names including `Capture`, `Games`, and `Playback`: https://learn.microsoft.com/en-us/windows/win32/procthread/multimedia-class-scheduler-service

## File Structure

- Modify `apps/desktop/native/native-voice-win/src/screen_video_capture.hpp`
  - Add explicit capture result state, timing fields, source dimensions, content dimensions, and failure codes.
- Modify `apps/desktop/native/native-voice-win/src/screen_video_capture.cpp`
  - Fix WGC frame pool resize and clipping.
  - Fix DXGI access-lost recovery.
  - Add async readback ring and optional GPU scale readback.
- Create `apps/desktop/native/native-voice-win/src/screen_capture_priority.hpp`
  - Owns process/thread/MMCSS/GPU priority setup for screen capture.
- Create `apps/desktop/native/native-voice-win/src/screen_capture_priority.cpp`
  - Implements `ScreenCapturePriorityScope` and D3D priority helpers.
- Modify `apps/desktop/native/native-voice-win/src/screen_publisher.cpp`
  - Use capture result states.
  - Measure capture, conversion, publish, and late-frame timings separately.
  - Install priority scope on the video thread.
- Modify `packages/platform/src/media.ts`
  - Extend native stats with capture timing, skipped frame, repeated frame, recovery, and priority fields.
- Modify `apps/desktop/src/main/native-media-engine-sidecar.ts`
  - Parse new sidecar diagnostics.
- Modify `apps/desktop/src/main/native-media-engine.ts`
  - Forward richer stats to renderer.
  - Keep preflight explicit.
- Modify `apps/web/src/features/voice/native-media-engine-stats.ts`
  - Store new capture diagnostics.
- Modify `apps/web/src/components/voice/voice-rtc-debug-view.tsx`
  - Show capture method, target FPS, delivered FPS, capture us, readback us, publish us, GPU priority, and recovery counts.
- Modify tests:
  - `apps/desktop/native/native-voice-win/tests/screen_capture_policy_test.cpp`
  - `apps/desktop/src/main/native-media-engine-sidecar.test.ts`
  - `apps/desktop/src/main/native-media-engine.test.ts`
  - `packages/platform/src/media.test.ts`
  - `apps/web/src/features/voice/native-media-engine-stats.test.ts`

---

### Task 1: Capture Result Contract

**Files:**
- Modify: `apps/desktop/native/native-voice-win/src/screen_video_capture.hpp`
- Modify: `apps/desktop/native/native-voice-win/src/screen_video_capture.cpp`
- Test: `apps/desktop/native/native-voice-win/tests/screen_capture_policy_test.cpp`
- Modify: `apps/desktop/native/native-voice-win/CMakeLists.txt`

- [ ] **Step 1: Add a focused result type**

Replace `virtual bool capture(ScreenVideoFrame& frame)` with a result enum. The point is to stop treating timeout, repeated frame, access lost, and real frame as the same thing.

```cpp
enum class ScreenCaptureFrameStatus {
  NewFrame,
  NoFrame,
  RepeatedFrame,
  RecoverableLost,
  FatalError,
};

struct ScreenCaptureFrameMetrics {
  uint32_t source_width = 0;
  uint32_t source_height = 0;
  uint32_t content_width = 0;
  uint32_t content_height = 0;
  uint32_t output_width = 0;
  uint32_t output_height = 0;
  int capture_us = 0;
  int readback_us = 0;
  int scale_us = 0;
  long hresult = 0;
};

struct ScreenCaptureFrameResult {
  ScreenCaptureFrameStatus status = ScreenCaptureFrameStatus::NoFrame;
  ScreenCaptureFrameMetrics metrics;
  std::string method;
};
```

- [ ] **Step 2: Update the abstract capturer API**

```cpp
class ScreenVideoCapturer {
public:
  static std::unique_ptr<ScreenVideoCapturer> create(
      const ScreenCaptureTarget& target,
      uint32_t width,
      uint32_t height);

  virtual ~ScreenVideoCapturer() = default;
  virtual ScreenCaptureFrameResult capture(ScreenVideoFrame& frame) = 0;
  virtual const char* method() const = 0;
};
```

- [ ] **Step 3: Update all three capturers to return explicit statuses**

For the first pass, keep behavior unchanged except for status mapping:

```cpp
if (!capture_frame) {
  if (last_bgra_.empty()) {
    return {ScreenCaptureFrameStatus::NoFrame, {}, method()};
  }
  frame.bgra = last_bgra_;
  frame.method = method();
  return {ScreenCaptureFrameStatus::RepeatedFrame, {}, method()};
}
```

For DXGI:

```cpp
if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
  return {ScreenCaptureFrameStatus::NoFrame, {}, method()};
}
if (hr == DXGI_ERROR_ACCESS_LOST) {
  ScreenCaptureFrameResult result;
  result.status = ScreenCaptureFrameStatus::RecoverableLost;
  result.method = method();
  result.metrics.hresult = static_cast<long>(hr);
  return result;
}
if (FAILED(hr)) {
  ScreenCaptureFrameResult result;
  result.status = ScreenCaptureFrameStatus::FatalError;
  result.method = method();
  result.metrics.hresult = static_cast<long>(hr);
  return result;
}
```

- [ ] **Step 4: Add a small enum unit test**

Create `apps/desktop/native/native-voice-win/tests/screen_capture_policy_test.cpp`:

```cpp
#include "../src/screen_video_capture.hpp"

#include <cassert>

int main() {
  using namespace syrnike::voice;
  ScreenCaptureFrameResult result;
  assert(result.status == ScreenCaptureFrameStatus::NoFrame);
  assert(result.metrics.output_width == 0);
  return 0;
}
```

- [ ] **Step 5: Register the test**

Add to `apps/desktop/native/native-voice-win/CMakeLists.txt`:

```cmake
add_executable(syrnike-native-screen-capture-policy-tests
  tests/screen_capture_policy_test.cpp
  src/screen_video_capture.cpp
  src/protocol.cpp
)

target_include_directories(syrnike-native-screen-capture-policy-tests PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(syrnike-native-screen-capture-policy-tests PRIVATE
  d3d11
  dxgi
  runtimeobject
  user32
  dwmapi
)

target_compile_definitions(syrnike-native-screen-capture-policy-tests PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)

add_test(
  NAME syrnike-native-screen-capture-policy-tests
  COMMAND syrnike-native-screen-capture-policy-tests
)
```

- [ ] **Step 6: Verify**

Run:

```powershell
pnpm --filter @syrnike13/desktop run build:native-voice
```

Expected: native helper and the new test target compile.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/native/native-voice-win/src/screen_video_capture.hpp apps/desktop/native/native-voice-win/src/screen_video_capture.cpp apps/desktop/native/native-voice-win/tests/screen_capture_policy_test.cpp apps/desktop/native/native-voice-win/CMakeLists.txt
git commit -m "refactor: make screen capture frame states explicit"
```

---

### Task 2: Diagnostics That Identify the Bottleneck

**Files:**
- Modify: `apps/desktop/native/native-voice-win/src/screen_publisher.cpp`
- Modify: `packages/platform/src/media.ts`
- Modify: `apps/desktop/src/main/native-media-engine-sidecar.ts`
- Modify: `apps/desktop/src/main/native-media-engine.ts`
- Modify: `apps/web/src/features/voice/native-media-engine-stats.ts`
- Modify: `apps/web/src/components/voice/voice-rtc-debug-view.tsx`

- [ ] **Step 1: Measure capture and publish separately**

In `captureScreenVideo`, measure these intervals:

```cpp
const auto capture_started_at = std::chrono::steady_clock::now();
const auto result = video_capturer->capture(captured_frame);
const auto capture_done_at = std::chrono::steady_clock::now();

bool published = false;
if (result.status == ScreenCaptureFrameStatus::NewFrame) {
  livekit::VideoFrame frame(
      static_cast<int>(width),
      static_cast<int>(height),
      livekit::VideoBufferType::BGRA,
      std::move(captured_frame.bgra));
  video_source->captureFrame(frame, timestamp_us);
  published = true;
}

const auto publish_done_at = std::chrono::steady_clock::now();
const auto capture_elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
    capture_done_at - capture_started_at);
const auto publish_elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
    publish_done_at - capture_done_at);
```

- [ ] **Step 2: Emit separate stats**

Extend the `screen_video_frame` event:

```cpp
emit("{\"type\":\"screen_video_frame\",\"session_id\":\"" +
     jsonEscape(session_id) +
     "\",\"frames\":" + std::to_string(frame_count) +
     ",\"interval_frames\":" + std::to_string(interval_frame_count) +
     ",\"target_fps\":" + std::to_string(fps) +
     ",\"late_frames\":" + std::to_string(interval_late_count) +
     ",\"no_frame_count\":" + std::to_string(interval_no_frame_count) +
     ",\"repeated_frame_count\":" + std::to_string(interval_repeated_frame_count) +
     ",\"recoverable_lost_count\":" + std::to_string(interval_recoverable_lost_count) +
     ",\"avg_capture_us\":" + std::to_string(avg_capture_us) +
     ",\"avg_publish_us\":" + std::to_string(avg_publish_us) +
     ",\"source_width\":" + std::to_string(last_metrics.source_width) +
     ",\"source_height\":" + std::to_string(last_metrics.source_height) +
     ",\"content_width\":" + std::to_string(last_metrics.content_width) +
     ",\"content_height\":" + std::to_string(last_metrics.content_height) +
     ",\"method\":\"" + jsonEscape(captured_frame.method) + "\"}");
```

- [ ] **Step 3: Parse sidecar fields**

In `native-media-engine-sidecar.ts`, extend the event shape and parser:

```ts
videoNoFrameCount: numberField(event, 'no_frame_count'),
videoRepeatedFrameCount: numberField(event, 'repeated_frame_count'),
videoRecoverableLostCount: numberField(event, 'recoverable_lost_count'),
videoAvgPublishUs: numberField(event, 'avg_publish_us'),
videoSourceWidth: numberField(event, 'source_width'),
videoSourceHeight: numberField(event, 'source_height'),
videoContentWidth: numberField(event, 'content_width'),
videoContentHeight: numberField(event, 'content_height'),
```

- [ ] **Step 4: Forward fields through platform stats**

Add optional fields to `NativeMediaStatsEvent` in `packages/platform/src/media.ts`:

```ts
videoNoFrameCount?: number
videoRepeatedFrameCount?: number
videoRecoverableLostCount?: number
videoAvgPublishUs?: number
videoSourceWidth?: number
videoSourceHeight?: number
videoContentWidth?: number
videoContentHeight?: number
```

- [ ] **Step 5: Show the metrics in RTC debug**

In `voice-rtc-debug-view.tsx`, add rows under the native screen share section:

```tsx
<StatRow label="Capture" value={`${share.videoAvgCaptureUs ?? 0} us`} />
<StatRow label="Publish" value={`${share.videoAvgPublishUs ?? 0} us`} />
<StatRow label="No frame" value={String(share.videoNoFrameCount ?? 0)} />
<StatRow label="Repeated" value={String(share.videoRepeatedFrameCount ?? 0)} />
<StatRow label="Recovered" value={String(share.videoRecoverableLostCount ?? 0)} />
<StatRow
  label="Source"
  value={`${share.videoSourceWidth ?? 0}x${share.videoSourceHeight ?? 0}`},
/>
<StatRow
  label="Content"
  value={`${share.videoContentWidth ?? 0}x${share.videoContentHeight ?? 0}`},
/>
```

- [ ] **Step 6: Verify**

Run:

```powershell
pnpm desktop:test
pnpm --filter @syrnike13/platform build
pnpm --filter @syrnike13/desktop typecheck
```

Expected: parser, platform types, and desktop typecheck pass.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/native/native-voice-win/src/screen_publisher.cpp packages/platform/src/media.ts apps/desktop/src/main/native-media-engine-sidecar.ts apps/desktop/src/main/native-media-engine.ts apps/web/src/features/voice/native-media-engine-stats.ts apps/web/src/components/voice/voice-rtc-debug-view.tsx
git commit -m "feat: expose native screen capture bottleneck diagnostics"
```

---

### Task 3: Fix WGC Resize and CS2 Top-Left Crop

**Files:**
- Modify: `apps/desktop/native/native-voice-win/src/screen_video_capture.cpp`
- Test: manual CS2 and window resize matrix

- [ ] **Step 1: Store current WGC frame pool size**

In `WgcScreenVideoCapturer`, add:

```cpp
winrt::Windows::Graphics::SizeInt32 pool_size_{};
```

Initialize it:

```cpp
const auto size = item_.Size();
pool_size_ = size;
native_width_ = static_cast<uint32_t>(std::max(1, size.Width));
native_height_ = static_cast<uint32_t>(std::max(1, size.Height));
```

- [ ] **Step 2: Add a WGC recreate helper**

```cpp
void recreateFramePool(winrt::Windows::Graphics::SizeInt32 size) {
  if (size.Width <= 0 || size.Height <= 0) return;
  pool_size_ = size;
  native_width_ = static_cast<uint32_t>(size.Width);
  native_height_ = static_cast<uint32_t>(size.Height);

  frame_pool_.Recreate(
      winrt_device_,
      directx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
      3,
      size);

  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = native_width_;
  desc.Height = native_height_;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_STAGING;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

  staging_.Reset();
  const HRESULT hr = device_->CreateTexture2D(&desc, nullptr, &staging_);
  if (FAILED(hr)) {
    throw std::runtime_error("failed to recreate wgc staging texture");
  }
}
```

- [ ] **Step 3: Use `ContentSize` every frame**

At the start of WGC frame handling:

```cpp
const auto content_size = capture_frame.ContentSize();
if (
    content_size.Width > pool_size_.Width ||
    content_size.Height > pool_size_.Height ||
    content_size.Width <= pool_size_.Width / 2 ||
    content_size.Height <= pool_size_.Height / 2
) {
  recreateFramePool(content_size);
  return {ScreenCaptureFrameStatus::NoFrame, {}, method()};
}
```

Then set metrics:

```cpp
ScreenCaptureFrameResult result;
result.status = ScreenCaptureFrameStatus::NewFrame;
result.method = method();
result.metrics.source_width = native_width_;
result.metrics.source_height = native_height_;
result.metrics.content_width = static_cast<uint32_t>(std::max(1, content_size.Width));
result.metrics.content_height = static_cast<uint32_t>(std::max(1, content_size.Height));
result.metrics.output_width = width_;
result.metrics.output_height = height_;
return result;
```

- [ ] **Step 4: Copy only valid content**

Call `copyScaledBgra` with content dimensions, not stale pool dimensions:

```cpp
copyScaledBgra(
    frame,
    source,
    static_cast<uint32_t>(std::max(1, content_size.Width)),
    static_cast<uint32_t>(std::max(1, content_size.Height)),
    mapped.RowPitch,
    width_,
    height_);
```

- [ ] **Step 5: Manual verification**

Run desktop app and test:

```powershell
pnpm desktop:dev
```

Expected:
- Resize a normal window while sharing it: no crop, no undefined right/bottom garbage.
- Start CS2 windowed, switch to borderless fullscreen, start share: no 150x600 top-left crop.
- Switch CS2 resolution while sharing: stream recovers within 1 second.
- RTC debug shows `content_width/content_height` matching current captured content.

- [ ] **Step 6: Commit**

```powershell
git add apps/desktop/native/native-voice-win/src/screen_video_capture.cpp
git commit -m "fix: recreate WGC frame pool when capture content size changes"
```

---

### Task 4: DXGI Access-Lost Recovery

**Files:**
- Modify: `apps/desktop/native/native-voice-win/src/screen_video_capture.cpp`

- [ ] **Step 1: Extract DXGI init into reusable reset**

In `DxgiScreenVideoCapturer`, split device creation from duplication creation:

```cpp
void createDuplication() {
  ComPtr<IDXGIOutput> output;
  HRESULT hr = adapter_->EnumOutputs(static_cast<UINT>(target_.screen_index - 1), &output);
  if (FAILED(hr)) throw std::runtime_error("failed to open dxgi output");

  ComPtr<IDXGIOutput1> output1;
  hr = output.As(&output1);
  if (FAILED(hr)) throw std::runtime_error("failed to open dxgi output1");

  DXGI_OUTPUT_DESC output_desc{};
  hr = output->GetDesc(&output_desc);
  if (FAILED(hr)) throw std::runtime_error("failed to read dxgi output desc");

  native_width_ = static_cast<uint32_t>(
      output_desc.DesktopCoordinates.right - output_desc.DesktopCoordinates.left);
  native_height_ = static_cast<uint32_t>(
      output_desc.DesktopCoordinates.bottom - output_desc.DesktopCoordinates.top);

  duplication_.Reset();
  hr = output1->DuplicateOutput(device_.Get(), &duplication_);
  if (FAILED(hr)) throw std::runtime_error("failed to duplicate dxgi output");
  recreateStaging(native_width_, native_height_);
}
```

Store the adapter:

```cpp
ComPtr<IDXGIAdapter> adapter_;
```

- [ ] **Step 2: Recover on access lost**

In `capture`:

```cpp
if (hr == DXGI_ERROR_ACCESS_LOST) {
  try {
    createDuplication();
    ScreenCaptureFrameResult result;
    result.status = ScreenCaptureFrameStatus::RecoverableLost;
    result.method = method();
    result.metrics.hresult = static_cast<long>(hr);
    return result;
  } catch (...) {
    ScreenCaptureFrameResult result;
    result.status = ScreenCaptureFrameStatus::FatalError;
    result.method = method();
    result.metrics.hresult = static_cast<long>(hr);
    return result;
  }
}
```

- [ ] **Step 3: Manual verification**

Run:

```powershell
pnpm desktop:dev
```

Expected:
- Share monitor.
- Alt-tab into and out of a fullscreen game.
- Change resolution or HDR/window mode if available.
- Stream recovers without restarting the share.
- RTC debug `recoverable_lost_count` increments during transition, then frame rate returns to target.

- [ ] **Step 4: Commit**

```powershell
git add apps/desktop/native/native-voice-win/src/screen_video_capture.cpp
git commit -m "fix: recover DXGI screen capture after access loss"
```

---

### Task 5: Fullscreen Game Strategy

**Status:** Skipped by product decision.

Do not implement monitor-compatible fullscreen game routing in this iteration. Keep current `game:` behavior unchanged: `game:` remains a WGC/window-style source, may work best-effort, and is not blocked or downgraded based on fullscreen state.

---

### Task 6: Capture Priority and GPU Scheduling

**Files:**
- Create: `apps/desktop/native/native-voice-win/src/screen_capture_priority.hpp`
- Create: `apps/desktop/native/native-voice-win/src/screen_capture_priority.cpp`
- Modify: `apps/desktop/native/native-voice-win/src/screen_publisher.cpp`
- Modify: `apps/desktop/native/native-voice-win/src/screen_video_capture.cpp`
- Modify: `apps/desktop/native/native-voice-win/CMakeLists.txt`

- [ ] **Step 1: Add priority scope header**

```cpp
#pragma once

#include <windows.h>

#include <optional>

#include <wrl/client.h>
#include <dxgi.h>

namespace syrnike::voice {

class ScreenCapturePriorityScope {
public:
  ScreenCapturePriorityScope();
  ~ScreenCapturePriorityScope();

  ScreenCapturePriorityScope(const ScreenCapturePriorityScope&) = delete;
  ScreenCapturePriorityScope& operator=(const ScreenCapturePriorityScope&) = delete;

  bool mmcss_enabled() const { return mmcss_handle_ != nullptr; }

private:
  HANDLE process_ = GetCurrentProcess();
  HANDLE thread_ = GetCurrentThread();
  DWORD old_priority_class_ = NORMAL_PRIORITY_CLASS;
  int old_thread_priority_ = THREAD_PRIORITY_NORMAL;
  DWORD mmcss_task_index_ = 0;
  HANDLE mmcss_handle_ = nullptr;
};

void setD3dGpuThreadPriority(IDXGIDevice* device, int priority);

}  // namespace syrnike::voice
```

- [ ] **Step 2: Implement process and thread priority**

```cpp
#include "screen_capture_priority.hpp"

#include <avrt.h>

namespace syrnike::voice {

ScreenCapturePriorityScope::ScreenCapturePriorityScope() {
  old_priority_class_ = GetPriorityClass(process_);
  old_thread_priority_ = GetThreadPriority(thread_);

  SetPriorityClass(process_, ABOVE_NORMAL_PRIORITY_CLASS);
  SetThreadPriority(thread_, THREAD_PRIORITY_HIGHEST);
  mmcss_handle_ = AvSetMmThreadCharacteristicsW(L"Capture", &mmcss_task_index_);
}

ScreenCapturePriorityScope::~ScreenCapturePriorityScope() {
  if (mmcss_handle_) AvRevertMmThreadCharacteristics(mmcss_handle_);
  SetThreadPriority(thread_, old_thread_priority_);
  if (old_priority_class_ != 0) SetPriorityClass(process_, old_priority_class_);
}

void setD3dGpuThreadPriority(IDXGIDevice* device, int priority) {
  if (!device) return;
  const int clamped = std::clamp(priority, -7, 7);
  device->SetGPUThreadPriority(clamped);
}

}  // namespace syrnike::voice
```

- [ ] **Step 3: Install scope only on video capture thread**

In `captureScreenVideo`:

```cpp
ScreenCapturePriorityScope priority_scope;
```

- [ ] **Step 4: Set D3D GPU thread priority**

After each D3D device creation:

```cpp
ComPtr<IDXGIDevice> priority_device;
if (SUCCEEDED(device_.As(&priority_device))) {
  setD3dGpuThreadPriority(priority_device.Get(), 3);
}
```

Start with `3`, not `7`. `7` is a debug experiment only. Microsoft warns this can hurt the foreground app if abused.

- [ ] **Step 5: Emit priority status**

Add to ready/stats events:

```cpp
",\"capture_thread_mmcss\":" + std::string(priority_scope.mmcss_enabled() ? "true" : "false")
```

- [ ] **Step 6: Verify under GPU load**

Run:

```powershell
pnpm desktop:dev
```

Test matrix:
- CS2 uncapped FPS, 1080p60 share.
- CS2 with FPS cap at monitor refresh, 1080p60 share.
- GPU synthetic load plus desktop monitor share.

Expected:
- Capture stays close to target when GPU is not fully saturated.
- Under saturation, `avg_capture_us/readback_us` shows whether GPU readback is blocked.
- Game remains playable. If game frametime worsens materially, reduce GPU priority from `3` to `1`.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/native/native-voice-win/src/screen_capture_priority.hpp apps/desktop/native/native-voice-win/src/screen_capture_priority.cpp apps/desktop/native/native-voice-win/src/screen_publisher.cpp apps/desktop/native/native-voice-win/src/screen_video_capture.cpp apps/desktop/native/native-voice-win/CMakeLists.txt
git commit -m "feat: prioritize native screen capture scheduling"
```

---

### Task 7: Async D3D Readback Ring

**Files:**
- Modify: `apps/desktop/native/native-voice-win/src/screen_video_capture.cpp`

- [ ] **Step 1: Replace immediate Map with a staging ring**

Add to both DXGI and WGC capturers:

```cpp
struct ReadbackSlot {
  ComPtr<ID3D11Texture2D> texture;
  bool pending = false;
};

std::array<ReadbackSlot, 3> readback_slots_;
size_t write_slot_ = 0;
size_t read_slot_ = 0;
```

- [ ] **Step 2: Issue copy into the next slot**

```cpp
auto& slot = readback_slots_[write_slot_];
context_->CopyResource(slot.texture.Get(), texture.Get());
slot.pending = true;
write_slot_ = (write_slot_ + 1) % readback_slots_.size();
```

- [ ] **Step 3: Map the oldest pending slot without blocking**

```cpp
auto& read_slot = readback_slots_[read_slot_];
if (!read_slot.pending) {
  return {ScreenCaptureFrameStatus::NoFrame, {}, method()};
}

D3D11_MAPPED_SUBRESOURCE mapped{};
HRESULT hr = context_->Map(
    read_slot.texture.Get(),
    0,
    D3D11_MAP_READ,
    D3D11_MAP_FLAG_DO_NOT_WAIT,
    &mapped);

if (hr == DXGI_ERROR_WAS_STILL_DRAWING) {
  return {ScreenCaptureFrameStatus::NoFrame, {}, method()};
}
if (FAILED(hr)) {
  return {ScreenCaptureFrameStatus::FatalError, {}, method()};
}
```

- [ ] **Step 4: Advance only after a successful map**

```cpp
copyScaledBgra(frame, source, native_width_, native_height_, mapped.RowPitch, width_, height_);
context_->Unmap(read_slot.texture.Get(), 0);
read_slot.pending = false;
read_slot_ = (read_slot_ + 1) % readback_slots_.size();
return {ScreenCaptureFrameStatus::NewFrame, metrics, method()};
```

- [ ] **Step 5: Verify**

Expected:
- When GPU is busy, capture thread does not block for long `Map` calls.
- `no_frame_count` may rise under true saturation, but the process should not collapse into multi-second stalls.
- If frames are available, 1080p60 remains the target and delivered cadence.

- [ ] **Step 6: Commit**

```powershell
git add apps/desktop/native/native-voice-win/src/screen_video_capture.cpp
git commit -m "perf: avoid blocking screen capture on D3D readback"
```

---

### Task 8: Stop Encoding Duplicate Timeout Frames

**Files:**
- Modify: `apps/desktop/native/native-voice-win/src/screen_publisher.cpp`
- Modify: `apps/desktop/native/native-voice-win/src/screen_video_capture.cpp`

- [ ] **Step 1: Do not publish repeated frames every tick**

In `captureScreenVideo`, only publish `NewFrame`:

```cpp
if (result.status == ScreenCaptureFrameStatus::NewFrame) {
  livekit::VideoFrame frame(
      static_cast<int>(width),
      static_cast<int>(height),
      livekit::VideoBufferType::BGRA,
      std::move(captured_frame.bgra));
  video_source->captureFrame(frame, timestamp_us);
  timestamp_us += 1000000 / fps;
  frame_count += 1;
  interval_frame_count += 1;
} else if (result.status == ScreenCaptureFrameStatus::RepeatedFrame) {
  interval_repeated_frame_count += 1;
} else if (result.status == ScreenCaptureFrameStatus::NoFrame) {
  interval_no_frame_count += 1;
}
```

- [ ] **Step 2: Keep target FPS semantics**

The loop still wakes at 60 FPS for `high60`; it just does not waste encode work on stale frames.

- [ ] **Step 3: Verify static and motion cases**

Expected:
- Static desktop no longer encodes 60 identical frames per second.
- Moving game still publishes up to 60 new frames per second.
- CPU usage drops in static or compositor-timeout cases.

- [ ] **Step 4: Commit**

```powershell
git add apps/desktop/native/native-voice-win/src/screen_publisher.cpp apps/desktop/native/native-voice-win/src/screen_video_capture.cpp
git commit -m "perf: skip stale screen frames instead of encoding duplicates"
```

---

### Task 9: GPU Scaling Before CPU Readback

**Files:**
- Modify: `apps/desktop/native/native-voice-win/src/screen_video_capture.cpp`

- [ ] **Step 1: Add a GPU output texture**

Create a D3D11 render target at output size:

```cpp
ComPtr<ID3D11Texture2D> scaled_texture_;
ComPtr<ID3D11RenderTargetView> scaled_rtv_;
```

Texture descriptor:

```cpp
D3D11_TEXTURE2D_DESC desc{};
desc.Width = width_;
desc.Height = height_;
desc.MipLevels = 1;
desc.ArraySize = 1;
desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
desc.SampleDesc.Count = 1;
desc.Usage = D3D11_USAGE_DEFAULT;
desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
```

- [ ] **Step 2: Render source texture into output texture**

Use a simple shader pass:

```cpp
// Vertex shader: full-screen triangle.
// Pixel shader: sample source SRV with linear clamp sampler.
// Render target: scaled_texture_.
```

Keep shader code in `screen_video_capture.cpp` as static byte arrays generated at build time only if the repo already has shader tooling. If not, use `ID3D11VideoProcessor` to avoid adding a shader compiler dependency.

- [ ] **Step 3: Read back output size only**

Copy `scaled_texture_` to staging instead of copying the full native frame to staging:

```cpp
context_->CopyResource(output_staging_.Get(), scaled_texture_.Get());
```

This is the biggest expected bandwidth win for 1440p/4K monitors because CPU readback becomes 1080p instead of full monitor resolution.

- [ ] **Step 4: Verify**

Expected:
- 4K monitor to 1080p60 has lower `avg_readback_us` and lower CPU usage.
- No quality preset change.
- Text remains acceptable. If text suffers, use point sampling for `text` quality and linear sampling for motion.

- [ ] **Step 5: Commit**

```powershell
git add apps/desktop/native/native-voice-win/src/screen_video_capture.cpp
git commit -m "perf: scale screen frames on GPU before readback"
```

---

### Task 10: Source Policy and Start-Time Preflight

**Status:** Skipped by product decision.

Do not add a start-time `capturePolicy` for `game:` sources in this iteration. Keep preflight explicit diagnostics only, and do not change fullscreen game routing.

---

### Task 11: Backpressure Without Quality Downgrade

**Files:**
- Modify: `apps/desktop/native/native-voice-win/src/screen_publisher.cpp`

- [ ] **Step 1: Keep only the latest frame when publish lags**

If `video_source->captureFrame` blocks or takes too long, do not queue old frames. Add counters:

```cpp
uint32_t interval_publish_slow_count = 0;
uint32_t interval_dropped_stale_count = 0;
```

If publish time exceeds one frame interval:

```cpp
if (publish_elapsed > frame_interval) {
  interval_publish_slow_count += 1;
}
```

- [ ] **Step 2: Record but do not auto-downgrade**

Emit:

```cpp
",\"publish_slow_count\":" + std::to_string(interval_publish_slow_count) +
",\"dropped_stale_count\":" + std::to_string(interval_dropped_stale_count)
```

- [ ] **Step 3: Verify**

Expected:
- Under encoder/network backpressure, stream stays real-time instead of building latency.
- The target FPS remains 60 for `high60`.
- Debug UI shows publish bottleneck instead of hiding it.

- [ ] **Step 4: Commit**

```powershell
git add apps/desktop/native/native-voice-win/src/screen_publisher.cpp
git commit -m "perf: keep native screen share realtime under publish backpressure"
```

---

### Task 12: Manual Performance Matrix

**Files:**
- Create: `docs/native-screen-capture-qa.md`

- [ ] **Step 1: Add QA matrix**

```markdown
# Native Screen Capture QA

## Required Scenarios

| Scenario | Source | Quality | Expected |
| --- | --- | --- | --- |
| Desktop idle | screen | 1080p60 | 55-60 delivered FPS, no late burst |
| Browser window resize | window | 1080p60 | no crop after resize |
| CS2 borderless | game | 1080p60 | no top-left crop |
| CS2 exclusive fullscreen | game | 1080p60 | current best-effort preserved; no new support in this iteration |
| CS2 GPU saturated uncapped | game | 1080p60 | no collapse to 5 FPS unless GPU is fully unavailable; diagnostics show bottleneck |
| Alt-tab from fullscreen | game/screen | 1080p60 | DXGI/WGC recovers |
| 4K monitor to 1080p | screen | 1080p60 | GPU scaling readback lower than CPU scaling baseline |

## Metrics To Record

- target_fps
- interval_frames
- late_frames
- avg_capture_us
- avg_publish_us
- no_frame_count
- repeated_frame_count
- recoverable_lost_count
- source_width/source_height
- content_width/content_height
- game FPS with and without stream
```

- [ ] **Step 2: Verify**

Run the matrix on a Windows gaming machine and record before/after rows in the PR description.

- [ ] **Step 3: Commit**

```powershell
git add docs/native-screen-capture-qa.md
git commit -m "docs: add native screen capture QA matrix"
```

---

## Rollout Order

1. Diagnostics first. Do not optimize blind.
2. WGC resize fix. This directly targets CS2 top-left crop.
3. DXGI recovery. This targets fullscreen transitions.
4. Priority/MMCSS/GPU priority. This targets the 5 FPS under game load symptom.
5. Async readback. This is the real fix for GPU queue stalls.
6. Duplicate-frame skip and GPU scaling. These are the main efficiency wins without lowering quality.
7. UI/debug polish and QA matrix.

## Risk Notes

- True exclusive fullscreen application-window capture is not guaranteed without injection. This iteration intentionally leaves fullscreen game behavior unchanged and does not block those sources.
- GPU priority can hurt the game if set too high. Start at `3`, profile, and reduce to `1` if game frametime worsens.
- Async readback trades a small amount of latency for stability. Use a 3-slot ring first; do not create an unbounded queue.
- GPU scaling adds D3D complexity. Do it after diagnostics and correctness fixes, not first.

## Definition of Done

- Window and borderless captures no longer crop after WGC content size changes.
- Fullscreen game behavior is unchanged and not blocked.
- 1080p60 remains the target preset.
- Under GPU load, the stream does not collapse to 5 FPS unless diagnostics prove the GPU is fully saturated and no frame is available.
- RTC debug makes the bottleneck obvious without reading native logs.
- No injection, no game hooks, no anti-cheat-sensitive process access beyond current window metadata.
