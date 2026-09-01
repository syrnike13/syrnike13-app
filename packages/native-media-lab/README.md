# Native v2 Media Lab

This package is the independent black-box observer and local harness for Native v2 Room/media work. Run it from the repository root with `pnpm native-media:lab`; Docker must already be running.

The harness owns only ephemeral test resources. It never reads production LiveKit configuration, writes credentials into the repository, or imports the native engine from the observer process. The generated report is ignored by Git and stored at `artifacts/latest-report.json`.

Issue #120 adds the non-production CPU screen oracle documented in [`docs/native-v2/SCREEN_CPU_REFERENCE.md`](../../docs/native-v2/SCREEN_CPU_REFERENCE.md). To run only its monitor, window, overload, lifecycle, and observer scenarios:

```powershell
$env:MEDIA_LAB_SCREEN_ONLY = 'true'
pnpm native-media:lab
```

Use `MEDIA_LAB_SCREEN_MODE` with a mode listed in that document to isolate one scenario. The repeat mode always exercises 30 full screen publication cycles.

To validate an unpublished local LiveKit fork without changing the repository
pin, set `MEDIA_LAB_LIVEKIT_SDK_ROOT` to the absolute directory containing its
`livekit.dll` and `livekit_ffi.dll`. The lab applies this override after its
normal native build, so the pinned SDK cannot silently replace the candidate.
