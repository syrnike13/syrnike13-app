# Native v2 Media Lab

This package is the independent black-box observer and local harness for Native v2 Room/media work. Run it from the repository root with `pnpm native-media:lab`; Docker must already be running.

The harness owns only ephemeral test resources. It never reads production LiveKit configuration, writes credentials into the repository, or imports the native engine from the observer process. The generated report is ignored by Git and stored at `artifacts/latest-report.json`.

Every run also disconnects a real SDK Room without sending an Engine off intent
and requires `room_connection_lost` to reach the public Engine snapshot within
two seconds while ping remains responsive. The transport samples the SDK's
synchronized terminal state every 100 ms on its owner lane, independently of
the lab's track delegate. Stale generations and callbacks after RoomOwner
destruction are ignored.

Issue #120 adds the non-production CPU screen oracle documented in [`docs/native-v2/SCREEN_CPU_REFERENCE.md`](../../docs/native-v2/SCREEN_CPU_REFERENCE.md). To run only its monitor, window, overload, lifecycle, and observer scenarios:

```powershell
$env:MEDIA_LAB_SCREEN_ONLY = 'true'
pnpm native-media:lab
```

Use `MEDIA_LAB_SCREEN_MODE` with a mode listed in that document to isolate one scenario. The repeat mode always exercises 30 full screen publication cycles.

To validate an unpublished local LiveKit fork without changing the repository
pin, set `MEDIA_LAB_LIVEKIT_SDK_ROOT` to the absolute directory containing its
`include`, `lib`, and `bin` directories. The isolated lab compiles and runs
against that explicit root; ordinary native builds keep using the verified pin.
