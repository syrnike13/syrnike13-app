# Capture backend supervisor transitions

`CaptureBackendSupervisor` is the sole owner of monitor-capture recovery. DXGI
and WGC report observations and never recreate themselves after capture starts.

| Current observation | Condition | Next state | Action |
|---|---|---|---|
| New frame | Preferred backend active | `healthy` | None |
| New frame | Fallback active and the 30 s probe interval elapsed | `reinitializing` | Probe DXGI; retain WGC if construction fails |
| No frame | Any backend | `no_content` | None; a static desktop is valid |
| No frame | No successful acquire for 15 s and Windows reports new user input | `reinitializing` | Recreate the active backend |
| Secure desktop | `OpenInputDesktop` denied access | `no_content` | Keep the backend and retry capture on the normal 200 ms cadence |
| Recoverable failure | First failure and backoff elapsed | `reinitializing` | Recreate the active backend |
| Recoverable/fatal failure | Second consecutive failure | `reinitializing` | Switch DXGI ↔ WGC |
| Device removed/reset/hung | Any backend and backoff elapsed | `reinitializing` | Drop both backends and recreate the D3D device |
| Target closed | Window or monitor disappeared | `failed` | Emit the terminal event |
| Encoder/RTP output stall | Recovery budget available and backoff elapsed | `reinitializing` | Replace the active publication/encoder without recreating capture |
| Encoder/RTP output stall | Three publication replacements in 60 s | `failed` | Emit one screen recovery terminal |
| Any recovery request | Backoff has not elapsed | `degraded` | Keep sampling; do not create D3D devices |

Backoff starts at 250 ms and caps at 5 s. Successful capture resets it. Encoder
backpressure is intentionally excluded because recreating capture cannot repair
an encoder that still owns every shared-texture slot.

`ScreenOutputStallDetector` is a progress observer only. It reports downstream
stalls to `CaptureBackendSupervisor`, which owns their backoff and recovery
budget as well as capture-backend transitions. `ScreenActor` executes the
returned action, while `ScreenPublicationController` only replaces the active
publication when explicitly instructed. Encoder backpressure never recreates
DXGI, WGC, or the capture D3D device.
