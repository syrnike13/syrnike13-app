# Issue #122: remote publication event contract blocker

Status: fixed, published and pinned as `v1.10.0-syrnike.4`, 2026-09-05. See
[receive/bridge verification](REMOTE_VIDEO_RECEIVE.md). The following local
candidate results are retained as historical red/green evidence.

The release source is `7e3a9465733666f6fa463c58d842e3702ed2e646`. Clean CI checkout
exposed that the former Rust pin `247ef11b8f4aa87dc877d6ad2a40b4b28cf78a4b`
existed only locally. The release instead pins published upstream
`1a477bc422c6890537b3bcdb017f0ac094d49661` and applies one consolidated native-v2
patch reproducing the tested source content, including #121 H264 support.
Tag `.3` failed before compilation and produced no assets; `.4` passed all
seven platform builds. Local `.4` rebuilt via `build.cmd`, passed all 359 unit
tests and repeated both real subscription/publication integration tests three
times. The published archive identity is recorded in `REMOTE_VIDEO_RECEIVE.md`.

## Local fix and verification

The sibling `client-sdk-cpp` repository retains shared ownership in the
participant map instead of moving the pointer before populating the event.
Its new `ManualVideoSubscriptionTest` checks the publication SID, manual
subscription, publication object identity in `TrackSubscribedEvent`, and a
decoded 640x360 BGRA frame through a capacity-one `VideoStream`.
That test and `RemoteTrackPublicationServerTest` passed three repetitions each
against disposable upstream LiveKit v1.13.6 Rooms.
The complete SDK unit suite passed 359 tests after correcting the old encoded
source acceptance expectation and adding empty-payload rejection assertions.
The application's native CTest suite passed all 19 tests with the local bundle.
Formatting and targeted clang-tidy completed without errors; pre-existing
warnings remain in the SDK. The standard token script could not run because
`lk` is absent, so real short-lived tokens were minted with the application's
existing `livekit-server-sdk` for the disposable local server.

The expanded application probe failed on the old #121 SDK and passed on the
candidate with `auto_subscribe=false`:

```json
{"accepted":true,"publishedEvents":1,"nullPublications":0,"autoSubscribe":false,"decodedFrame":true}
```

The local bundle is `../client-sdk-cpp/sdk-out/livekit-sdk-issue122`, built via
`build.cmd release-tests --bundle --prefix <fresh-output-directory>` with
`CMAKE_GENERATOR=Ninja` in the VS 2026 x64 developer environment. Source base:
`8bcb6e866958639002697be41549dea6af70b0e1`, Rust pin:
`247ef11b8f4aa87dc877d6ad2a40b4b28cf78a4b`, plus the local C++ fix and the
repository's existing Rust patch series. The stale context in patch 0002 was
updated to match that Rust pin; all three patches were verified against an
isolated index of the pin. This candidate is not a published release.

SHA-256 of the tested bundle:

- `livekit.dll`: `51f8a1c199ed0b4f05157996366b979feda97434b91d5696750e14aa82808b68`
- `livekit_ffi.dll`: `44dc29cf95108c12dbab54cdedb1acfe3cb8dcaa76b85834ccebeef2ad06c700`

The local Media Lab build uses this SDK override. Evidence in its ignored
`artifacts/` directory: `sdk-contract-red.json`,
`sdk-contract-integration-green.json`, and `sdk-contract-probe-green.json`.

## Failure

With `RoomOptions::auto_subscribe = false`, a receiver joins a disposable Room,
then a second participant publishes a video track. The public
`RoomDelegate::onTrackPublished` callback fires with a null `publication`.
The remote track owner therefore cannot use this event to identify the
publication or call `RemoteTrackPublication::setSubscribed(true)`.

Observed with both the pinned `1.10.0-syrnike.2` runtime and the local SDK used
for issue #121, against upstream LiveKit server v1.13.6:

```json
{"accepted":false,"publishedEvents":1,"nullPublications":1,"autoSubscribe":false}
```

Both probes exited with code 2. Connect, publication, and disconnect completed;
this is not a connection timeout or missing server credentials.

## Cause

In the standalone C++ mirror's `src/room.cpp`, the `kTrackPublished` case moves
`rpublication` into `mutableTrackPublications()` and subsequently assigns the
moved-from shared pointer to `ev.publication`. This ordering is present at the
application's pinned mirror commit
`f1b3d160300c4fb2043cdff455d234e1b3ec3915` as well as the local #121 source.

The minimal mirror correction is to retain the event's shared ownership before
moving the local pointer into the participant map. It needs a regression test
that receives a real publication event, checks its non-null publication/SID,
and manually subscribes and receives a decoded frame. It does not require a
zero-copy decoder change.

## Reproduction

`remote_video_contract_probe` is an opt-in target under
`WINDOWS_MEDIA_BUILD_LAB=ON`. Build it with the configured native CMake build:

```text
cmake --build packages/windows-media-engine/build --config Release --target remote_video_contract_probe
```

Supply `LIVEKIT_URL`, `LIVEKIT_OBSERVER_TOKEN`, and
`LIVEKIT_PUBLISHER_TOKEN` for two distinct identities in the same disposable
Room, and execute `build/Release/remote_video_contract_probe.exe` under a
25-second outer process deadline. The probe prints a JSON contract result and
returns 0 for a valid event and decoded frame, 2 for a contract violation, or 1 for setup failure.
It does not use production credentials or modify the SDK.

Local machine-readable evidence is in the ignored Media Lab artifacts:
`remote-video-contract.json` and `remote-video-contract-pinned.json`. The
second run used the `.2` runtime DLLs in a separate probe directory; the
application build's SDK override and runtime DLLs were not replaced.

## Scope consequence

Issue #122 requires a remote publication owner with controlled subscription
and says to stop when basic public LiveKit functionality requires a vendor
patch. This defect is in the publication event preceding decoded ingress.
Treating it as a prerequisite blocker avoids silently enabling subscriptions
for every track or working around the event through mutable SDK internals.

The contract and viewer are unblocked using the published, hash-pinned SDK.
The local override is no longer required for a fresh application build.

The Electron side has a suitable documented safety primitive:
[`allReferencesReleased`](https://www.electronjs.org/docs/latest/api/shared-texture).
The implemented pool waits for this callback, not a renderer message or
timeout as permission to overwrite an imported texture.
