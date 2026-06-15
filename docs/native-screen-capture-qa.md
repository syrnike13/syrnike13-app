# Native Screen Capture QA

Use this checklist after Windows native voice helper changes that touch screen
capture timing, readback, or source sizing.

## Scope

- Keep screen capture quality at the requested FPS. Do not validate fixes by
  lowering 60 FPS sessions to 30 FPS.
- Do not use game injection for validation.
- Exclusive fullscreen games are current best-effort behavior in this iteration:
  they are not blocked, but no new supported capture path is expected.

## Required Cases

| Case | Source | Expected |
| --- | --- | --- |
| Desktop monitor | `screen:*` | DXGI publishes near target FPS, `recoverable_lost_count` stays near zero after startup, `capture_thread_mmcss` is reported. |
| Busy GPU monitor | `screen:*` with a GPU-heavy app visible | Stream remains responsive; `avg_publish_us` and `no_frame_count` identify bottlenecks without reducing configured FPS. |
| Resized window | `window:*` | WGC keeps publishing after resize; `source_width/source_height` and `content_width/content_height` update instead of cropping the old top-left area. |
| Windowed/borderless game | `game:*` | Current WGC/GDI best-effort path continues; no injection, no special fullscreen routing. |
| Exclusive fullscreen game | `game:*` | Current best-effort behavior is preserved and not blocked. Full support is out of scope for this iteration. |
| Monitor disconnect or display mode change | `screen:*` | DXGI recovers from access-lost without terminating the helper; `recoverable_lost_count` increments. |

## Useful Debug Fields

- `avg_capture_us`: time spent obtaining a capture frame before publish.
- `avg_readback_us`: time spent mapping the D3D staging texture for CPU read.
- `avg_scale_us`: time spent copying or scaling BGRA pixels after readback.
- `avg_publish_us`: time spent handing the frame to LiveKit/WebRTC.
- `no_frame_count`: capture ticks with no publishable frame.
- `repeated_frame_count`: should stay zero unless a capturer intentionally starts
  reporting duplicates.
- `recoverable_lost_count`: WGC resize or DXGI access-lost recovery.
- `source_width/source_height`: native source or frame-pool size.
- `content_width/content_height`: actual content size used for readback.
- `capture_thread_mmcss`: whether the capture thread received MMCSS priority.
