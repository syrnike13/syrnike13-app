# Known external bugs

This file records reproducible bugs and constraints in the local environment, toolchain, operating system, or third-party libraries that the application repository cannot fix. Application defects do not belong here.

## Media Foundation activation retains handles on the NVIDIA test machine

On 2026-09-09, Windows 11 build 26200 with RTX 5070 Ti, driver
`32.0.16.1074` and injected `nvspcap64.dll` version `11.0.9.239` retained two
handles per hardware H264 MFT activation/shutdown. A 100-cycle probe on one
thread returned 321 -> 521 process handles and 10 -> 10 threads. The probe
only enumerates, activates, calls `IMFActivate::ShutdownObject`, releases COM
references and shuts down Media Foundation; it does not submit frames or use
the application encoder pipeline. MFStartup/MFShutdown and enumeration alone
showed no growth. Ordinary encoder start/stop and withheld-output faults also
showed approximately two additional handles per cycle.

The growing handle types are a mutex and section with names based on
`{2627E361-24E2-4F14-99ED-A20D0685D8DD}_v22`. That string occurs in the installed
NVIDIA overlay DLL. A control run with the overlay disabled has not yet been
authorized/performed, so overlay involvement is a hypothesis rather than a
confirmed root cause. No driver or overlay settings have been changed.

Reproduce with `encoder_fault_tests --same-thread-activation`; use
`--resource-stages` to isolate startup, enumeration and activation. The probe
follows the documented
[activation shutdown contract](https://learn.microsoft.com/en-us/windows/win32/api/mfobjects/nf-mfobjects-imfactivate-shutdownobject).
Both activation-only shutdown and explicit transform shutdown plus activation
shutdown reproduced growth. Additional end-streaming/device-manager cleanup did
not resolve it and was not retained as a product workaround.

The fault harness reports resource failure and exits nonzero. This blocks the
encoder resource qualification on this setup; successful owner assertions are
not a complete PASS. Process containment closes resources when the utility exits,
but does not establish zero growth during repeated encoder lifecycles.

## Electron managed shared-texture transfer can lose late renderer releases

On Electron 43.1.0, a delayed managed texture transfer during native utility loss
produced renderer errors from `IMPORT_SHARED_TEXTURE_RELEASE_RENDERER_TO_MAIN`
with `Shared texture ... not found`. The
[main implementation](https://github.com/electron/electron/blob/v43.1.0/lib/browser/api/shared-texture.ts)
registers renderer references only after a 1000 ms transfer race succeeds. A late
renderer import after that timeout is consequently absent from reference tracking;
releasing the main reference removes its record. The
[renderer implementation](https://github.com/electron/electron/blob/v43.1.0/lib/renderer/api/shared-texture.ts)
then invokes the missing record from an asynchronous release callback without
handling rejection.

Product integration uses the documented `sharedTexture.subtle` API with separate
import and GPU-release acknowledgements and a process-wide retention bound.
Timeouts retain uncertain GPU leases rather than treating them as released. This
does not patch Electron or change native capture/encoding algorithms.

## MSVC cannot resolve long nested WebRTC include paths

An isolated SDK checkout on Windows can exceed the native compiler's supported
include-path length under `target/release/build/scratch-*/out/livekit_webrtc/`.
Observed with MSVC 14.51 on 2026-09-05: `C1083` for
`absl/strings/internal/str_format/constexpr_parser.h`, even though the header
exists. A junction at `target/` does not shorten the logical path reported by
the cached `scratch` build helper. Use the SDK's existing `LK_CUSTOM_WEBRTC`
environment option pointing at a short junction to the same prebuilt WebRTC
bundle, and an explicit `CARGO_TARGET_DIR`. No compiler reinstall or machine-wide
setting change is required.

## Hosted Windows runner has no D3D11 Video interfaces

The `windows-2025-vs2026` GitHub-hosted runner used by native CI does not expose
the D3D11 Video interfaces required by monitor device checks, GPU conversion
and hardware H264 encoder fault tests. Confirmed on 2026-09-05 in
[job 101261582758](https://github.com/syrnike13/syrnike13-app/actions/runs/33949541934/job/101261582758):
the failures are `process D3D11 device has no video interface` and
`D3D11 video processor interfaces are unavailable`.

These tests carry CTest label `requires-gpu-video` and remain part of the full
default suite. Hosted CI explicitly excludes that label and reports this
coverage boundary. Validate the complete suite on a Windows GPU machine and
retain hardware/ASan evidence before merging media changes; installing SDKs on
the hosted runner cannot provide the missing hardware capability.

## Docker Desktop fails to restart on Windows build 26200

### Symptoms

- Docker Desktop opens and immediately reports an unexpected backend error.
- `docker version` cannot connect to `npipe:////./pipe/dockerDesktopLinuxEngine` because the pipe does not exist.
- The current `com.docker.backend.exe.log` reports error 1920, `The file cannot be accessed by the system`, while removing one of these AF_UNIX sockets:
  - `%LOCALAPPDATA%\Docker\run\sailor-ingest.sock`
  - `%LOCALAPPDATA%\Docker\run\dockerInference`
  - `%LOCALAPPDATA%\docker-secrets-engine\engine.sock`
- The socket appears as a zero-byte NTFS `ReparsePoint`; reading its ACL, deleting it, or querying it with `fsutil` can also fail with error 1920.

### Known affected setup

- Windows `10.0.26200.7309`
- Docker Desktop `4.88.1.237512`
- Docker Engine `29.7.2`
- WSL `2.7.12.0`, kernel `6.18.33.2-2`

This is a Docker Desktop/Windows AF_UNIX socket bug, not a missing virtualization feature. On the affected machine, firmware virtualization, the Windows hypervisor, and the Windows Hypervisor Platform API were verified as operational.

Docker tracks the same failure in [docker/desktop-feedback#531](https://github.com/docker/desktop-feedback/issues/531) and [docker/desktop-feedback#554](https://github.com/docker/desktop-feedback/issues/554).

### Recovery

1. Fully stop every Docker Desktop process before touching the socket directories.
2. Set `"EnableDockerAI": false` in `%APPDATA%\Docker\settings-store.json`. Docker Model Runner remains unavailable while this workaround is active.
3. Rename both parent directories in the same recovery attempt, preserving them as timestamped backups:
   - `%LOCALAPPDATA%\Docker\run`
   - `%LOCALAPPDATA%\docker-secrets-engine`
4. Start Docker Desktop and verify the server with `docker version` and `docker info`. Use `docker run --rm hello-world` when an end-to-end pull and container test is appropriate.

An unclean Docker Desktop stop can reproduce the corruption. Cleaning only one directory can create a loop: startup fails on the other socket and recreates the first broken socket, so both directories must be handled before one clean start.

### Data safety

Do not use Factory Reset and do not delete `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`; those actions are unnecessary and can destroy local images, containers, and volumes. Rename the socket parent directories instead, because the corrupted reparse points may be impossible to delete normally.
