# Native media priority policy

The production default is `normal`. Capture thread priority stays
`THREAD_PRIORITY_NORMAL`, MMCSS stays off, and both D3D GPU priorities stay 0
unless `SYRNIKE_MEDIA_PRIORITY_POLICY` overrides the process. The elevated
12-second CI matrix on 2026-08-16 also selected `normal`. The only typed
capability blocker on this host remains the missing Bluetooth render/capture
endpoint pair.

## Candidate order

The selector evaluates candidates from the lowest scheduling intervention to
the highest and chooses the first complete passing observation:

| Policy | Capture thread | MMCSS | Publication D3D | Preview D3D |
| --- | ---: | --- | ---: | ---: |
| `normal` | Normal | Off | 0 | 0 |
| `capture` | Normal | `Capture` | 1 | 0 |
| `legacy-high` | Highest | `Capture` | 3 | 2 |

Each setting is attempted once. Diagnostics record the requested and observed
thread priority, MMCSS registration plus Win32 error, and requested and
observed D3D priority plus HRESULT; a failure is an assertion failure and does
not trigger an uncontrolled retry or elevation loop.

## 2026-08-14 CI observation

The 12-second production-shaped profile ran real WGC/DXGI capture, local
preview, hardware H.264, Electron shared textures and renderer fences, remote
video, audio, deterministic recovery faults, and a concurrent 1080p CPU+D3D
workload. The Windows audio-policy matrix was supplied; its only capability
blocker was that this host has no active Bluetooth render/capture endpoint
pair.

| Policy | UI p95 / p99 | Video age p95 / p99 | Audio age p95 / p99 / max | Screen fps | Screen gap max | Competitor fps | Competitor p95 / p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `normal` | 2.70 / 5.50 ms | not recorded / 8 ms | not recorded / not recorded / 78.54 ms | 12.74 | 868.16 ms | 59.99 | 17.58 / 19.06 ms |
| `capture` | 2.40 / 4.20 ms | not recorded / 7 ms | not recorded / not recorded / 79.55 ms | 15.08 | 917.93 ms | 59.99 | 17.47 / 17.87 ms |
| `legacy-high` | 2.80 / 5.10 ms | not recorded / 7 ms | not recorded / not recorded / 78.14 ms | 16.91 | 820.14 ms | 59.99 | 17.47 / 18.09 ms |

All three observations had zero assertion failures, zero screen GPU slot
timeouts, exact thread/MMCSS/D3D outcomes, and all four deterministic fault
hits. They predate the frame-p95 and audio-p95/p99 instrumentation, and WPR
failed before recording with `0xc5585011`, so they are diagnostic context rather
than selection evidence.

An ETL now counts only when `xperf tracestats -timespan actual -detail` reports
a trace covering at least 90% of the contention window and positive event
counts for every required domain: `CSwitch` plus `ReadyThread` scheduling,
`DxgKrnl` queue/packet events, `Dwm-Core`, `DirectComposition`, `Win32k`, an
encoder-specific `MediaFoundation` or `DXVA2` task (including Windows 11
`MediaFoundation-Performance` MFT process-output events), and audio wakeups from
either `AudioEngine` or Windows 11 `Microsoft.Windows.Audio.Service` /
`Microsoft.Windows.Audio.Client` stream-start events. Provider totals, zero-count
rows, and generic `DX` events are not evidence. A decodable trace missing any
domain blocks the whole matrix instead of selecting from partial evidence. A
contention observation is selectable only when it passes; the sole allowed
blocker is the typed `bluetooth_endpoint_pair_absent` capability outcome.

The audio p95/p99 distribution also carries its native sample count. CI needs
at least 600 normal playout-age samples and production needs at least 30,000;
short or discarded distributions fail instead of presenting percentiles from
too little data.

## 2026-08-16 elevated CI selection

WPR recorded `CPU.light`, `GPU.light`, `DesktopComposition.light`,
`Audio.light`, `Video.light`, and `MF.light` on a local disk after LiveKit join
tokens were minted outside the trace window. Each ETL stayed under 512 MiB
(~361–371 MiB compressed), covered ~26 s (more than 90% of the 12 s contention
window plus completion), and `xperf tracestats` reported zero lost events with
positive counts for scheduling, GPU queue, DWM, renderer, capture, encoder, and
audio wakeups.

| Policy | UI p95 / p99 | Video age p95 / p99 | Audio age p95 / p99 / max (n) | Screen fps | Screen gap max | Competitor fps | Competitor p95 / p99 | ETL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `normal` | 10.1 / 17.4 ms | 16 / 21 ms | 67.52 / 67.75 / 68.10 ms (1074) | 13.57 | 300.30 ms | 60.00 | 17.73 / 18.80 ms | 371 MiB |
| `capture` | 11.9 / 14.3 ms | 16 / 19 ms | 67.58 / 67.76 / 67.88 ms (1079) | 13.65 | 346.40 ms | 59.99 | 17.89 / 18.24 ms | 363 MiB |
| `legacy-high` | 12.4 / 26.0 ms | 18 / 25 ms | 66.94 / 67.17 / 67.36 ms (1097) | 13.33 | 317.02 ms | 60.00 | 17.83 / 18.31 ms | 361 MiB |

`normal` and `capture` had zero assertion failures and zero screen GPU slot
timeouts. `legacy-high` recorded FFmpeg H.264 stderr (`corrupted macroblock` /
`Broken frame packetizing`) on probe epoch 3; that does not affect selection
because the selector already chose `normal`. Artifact:
`packages/desktop-native/artifacts/media-priority/ci/media-priority-matrix-2026-08-16T12-39-46-825Z.json`.

The native fallback stayed `legacy-high` until the 2026-08-18 600-second
production soaks below kept audio max under 80 ms on `normal`.

## 2026-08-17 production matrix

The 600-second elevated matrix recorded full ETW for `normal` and `capture`
(`CPU.light` through `MF.light`, ~24 s, 368–423 MiB, every required domain
present, lost-event counts absent). `legacy-high` in the last rerun missed
first-frame presentation, so that candidate is not selectable. Artifact:
`packages/desktop-native/artifacts/media-priority/production/media-priority-matrix-2026-08-17T13-51-31-533Z.json`
(complete three-policy soak) and
`packages/desktop-native/artifacts/media-priority/production/media-priority-matrix-2026-08-17T14-25-38-603Z.json`
(ETW-complete `normal`/`capture`, incomplete `legacy-high`).

| Policy | UI p95 / p99 | Audio age p95 / p99 / max | Screen fps | Screen gap max | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `normal` | 14.3 / 21.6 ms | 78.13 / 78.93 / 83.42 ms | 26.86 | 578 ms | audio max > 80 ms |
| `capture` | 15.6 / 21.8 ms | 78.73 / 79.19 / 87.62 ms | 27.00 | 581 ms | audio max > 80 ms |
| `legacy-high` | 15.1 / 20.7 ms | 79.16 / 79.49 / 87.48 ms | 26.82 | 598 ms | audio max > 80 ms |

All three 600-second soaks kept audio p95/p99 under 80 ms and completed the
injected recovery script (renderer reload, GPU fault, four audio-gap samples).
Ordinary playout-age **max** stayed 83–88 ms on that date, so no candidate was
selectable yet. The host still has no Bluetooth endpoint pair. Do not raise
the 80 ms audio max to make a policy pass.

Those 83–88 ms peaks came from filling the 50 ms WASAPI render buffer to
capacity. Steady-state padding is now 30 ms; the extra 20 ms stays available
for underrun. That change is what made a later 600-second soak selectable.

## 2026-08-18 production soak

Independent 600-second soaks without ETW, after the 30 ms padding change and
probe lifecycle fixes. Each run used the rebuilt probe; the only allowed
blocker was `bluetooth_endpoint_pair_absent`.

| Policy | UI p95 / p99 | Audio age p95 / p99 / max (n) | Screen fps | Screen gap max | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `normal` | 13.5 / 21.6 ms | 76.21 / 78.08 / 78.77 ms (34258) | 25.32 | 618 ms | selectable |
| `capture` | 11.6 / 19.1 ms | 75.20 / 75.79 / 76.36 ms (36622) | 25.65 | 239 ms | selectable |
| `legacy-high` | 11.9 / 25.0 ms | 77.74 / 78.32 / 78.83 ms (36711) | 26.02 | 603 ms | probe epoch-2 `0xC0000005` |

Artifacts:
`packages/desktop-native/artifacts/media-priority/production-verify-drain/`,
`production-verify-capture/`, and `production-verify-legacy-high/`.

`normal` is the production fallback and the contention-runner default. A
later elevated production ETW matrix can still confirm scheduling domains; it
is not required to keep `normal` selected.

## Required elevated rerun

Build the current sources and create the audio-policy input before elevation:

```powershell
pnpm --filter @syrnike13/platform build
pnpm --filter @syrnike13/desktop exec tsup
pnpm --filter @syrnike13/desktop-native build
& packages/desktop-native/build/Release/syrnike-native-windows-audio-policy-matrix.exe `
  --output packages/desktop-native/build/windows-audio-policy-matrix.json
```

Then run the CI matrix from an elevated terminal on the target game hardware.
Separate output directories preserve the CI matrix JSON when the production
rotation runs later. ETL files, WPR temporary files, and `xperf tracestats`
output must land on a local disk outside Nextcloud/OneDrive/Dropbox; pass
`--trace-dir` (or `SYRNIKE_ETW_TRACE_DIR`) when `--output-dir` is inside a
sync folder:

```powershell
pnpm --filter @syrnike13/desktop-native profile:media-priority:ci -- `
  --build-dir build/Release `
  --livekit-server path\to\livekit-server.exe `
  --audio-policy-result build/windows-audio-policy-matrix.json `
  --output-dir build/media-priority-artifacts/ci `
  --trace-dir G:\syrnike13-build-cache\media-priority-etw `
  --contention-output-dir build/media-priority-artifacts/ci/contention
```

The wrapper mints LiveKit join tokens before WPR starts, then records
`CPU.light`, `GPU.light`, `DesktopComposition.light`,
`Audio.light`, `Video.light`, and a custom Media Foundation profile that enables
the Win11 `MediaFoundation-Performance` providers, with `-recordtempto` on the
trace directory,
writes full `xperf tracestats` beside each ETL, validates duration and positive
event counts, records at most 30 seconds of ETW even when the soak is longer
(512 MiB cannot hold a 600-second `CPU.light` trace), caps each ETL at 512 MiB,
and retains at most three ETLs, three
tracestats files, and three matrix JSON files. Exit `0` means the final matrix
JSON contains a selection; exit `2` means evidence was blocked and exit `1`
means no policy passed. Token minting stays outside the WPR window so the 32
`create-join-token` process spawns cannot inflate the ETL past the bound or
starve under `CPU.light`. The 30-second ETW window must still cover every
required domain; the soak assertions keep their full CI or production duration.

The wrapper owns a WPR session only after its start succeeds and cancels that
session on errors, `SIGINT`, and `SIGTERM`. After an interrupted shell or forced
termination, verify and recover before rerunning:

```powershell
& C:\Windows\System32\wpr.exe -status
& C:\Windows\System32\wpr.exe -cancel
```

Run `-cancel` only when `-status` reports the interrupted experiment's active
recording; WPR recording state is machine-wide, so an unrelated trace must not
be cancelled.

If CI selects a policy, run the independent production matrix from the same
elevated terminal:

```powershell
pnpm --filter @syrnike13/desktop-native profile:media-priority:production -- `
  --build-dir build/Release `
  --livekit-server path\to\livekit-server.exe `
  --audio-policy-result build/windows-audio-policy-matrix.json `
  --output-dir build/media-priority-artifacts/production `
  --trace-dir G:\syrnike13-build-cache\media-priority-etw `
  --contention-output-dir build/media-priority-artifacts/production/contention
```

Production runs all three candidates for at least 600 seconds each. The native
fallback and contention-runner default are already `normal`. If a later matrix
selects a different policy, apply that `selection.selectedPolicy` the same
way: update this document, the native fallback assertion, and the runner
default, then rerun the selected policy once after that source change.
