# Native media priority policy

The production default remains `legacy-high` until an elevated ETW matrix
selects a lower policy. The application-level CI matrix passed every media and
competing-workload assertion for all three candidates, but WPR could not start
without the Windows **Profile system performance** privilege, so the selector
correctly returned `blocked` instead of treating incomplete evidence as a win.

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
encoder-specific `MediaFoundation` or `DXVA2` task, and `AudioEngine`. Provider
names, zero-count rows, and generic `DX` events are not evidence. A decodable
trace missing any domain blocks the whole matrix instead of selecting from
partial evidence. A contention observation is selectable only when it passes;
the sole allowed blocker is the typed `bluetooth_endpoint_pair_absent`
capability outcome.

The audio p95/p99 distribution also carries its native sample count. CI needs
at least 600 normal playout-age samples and production needs at least 30,000;
short or discarded distributions fail instead of presenting percentiles from
too little data.

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
Separate output directories preserve the CI ETLs when the production rotation
runs later:

```powershell
pnpm --filter @syrnike13/desktop-native profile:media-priority:ci -- `
  --build-dir build/Release `
  --livekit-server path\to\livekit-server.exe `
  --audio-policy-result build/windows-audio-policy-matrix.json `
  --output-dir build/media-priority-artifacts/ci `
  --contention-output-dir build/media-priority-artifacts/ci/contention
```

The wrapper records `CPU.light`, `GPU.light`, `DesktopComposition.light`,
`Audio.light`, and `Video.light`, validates duration and positive event counts
with `xperf`, caps each ETL at 512 MiB, and retains at most three ETLs and three
matrix JSON files per output directory. Exit `0` means the final matrix JSON
contains a selection; exit `2` means evidence was blocked and exit `1` means no
policy passed.

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
  --contention-output-dir build/media-priority-artifacts/production/contention
```

Production runs all three candidates for at least 600 seconds each. Apply the
`selection.selectedPolicy` from the production matrix to the native fallback
and the contention-runner default, update this document with its frame, audio,
UI and competing-workload p95/p99 values, add a native assertion for the new
fallback, then rerun the selected policy once after that source change.
