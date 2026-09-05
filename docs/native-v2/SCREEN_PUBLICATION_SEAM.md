# Production screen publication seam

Issue #120 proves delivery through a disposable CPU reference process. Issue #121 must build a separate production path: it may reuse normalized frame metadata, receiver markers, age/drop rules, and black-box scenarios, but it must not depend on `lab::ReferenceScreenSender` or receive a `shared_ptr<livekit::Room>`.

## Ownership boundary

```text
Screen pipeline owner                     Room/media-session owner
  capture leases                            LiveKit Room and participant
  bounded GPU slots       commands ->       track/source/publication lifecycle
  converter and encoder    events <-        serialized SDK operation lane
  frame age/drop policy                     utility-epoch fault escalation
```

The production seam is an asynchronous bounded command/event port. Commands identify a screen publication generation and carry only a track descriptor, an encoded-frame slot/token, a keyframe request, or a stop request. Events acknowledge publication, slot consumption, unpublication, and terminal failure. Calls enqueue or reject immediately; they never execute LiveKit synchronously on the capture, converter, encoder, Engine-control, or Electron thread.

The Room/media-session owner is the only code allowed to translate those commands into LiveKit operations. It serializes publication state with the Room lifecycle, fences late completions by generation, and returns an encoded slot only after the SDK no longer borrows it. Screen failure stops that screen generation without transferring Room ownership to the screen pipeline.

## Bounds and failure

- The command mailbox, event mailbox, encoded-slot pool, and in-flight publication count have fixed capacities declared beside their implementations. Overload drops an old video frame before it delays control or stop commands.
- Publish, submit, unpublish, D3D mapping, conversion, and encoder operations each have typed deadlines. A cooperative timeout ends only the affected generation; a non-returning native/SDK call retires the media utility epoch because C++ cannot safely reclaim unknown borrowed resources in-process.
- Stop is complete only after capture callbacks are revoked, pending/active frames are released, encoder slots are returned, and unpublication is acknowledged or the utility epoch has been retired.

## Implementation

Issue #121 implements this boundary in `screen/production_screen_sender.*`. The
port has two consumers: `livekit/LiveKitScreenPublicationAdapter` translates it
onto `LiveKitRoomTransport`'s serialized SDK lane, while the deterministic test
adapter can hold and complete publish, frame, and unpublish calls independently.
The video mailbox has one active and one ordered pending encoded frame. Further
admission returns `VideoBackpressure` without borrowing or superseding a slot. The event
mailbox has sixteen entries with four reserved for control, and every borrowed
encoded slot produces exactly one release event after the SDK call returns.

`screen/production_screen_pipeline.*` owns capture consumption, GPU conversion,
the hardware encoder, and slot leases, but receives its publication adapter from
a factory. This keeps `Room`, participant, track, and source ownership on the
media-session side. A hung SDK call leaves its active encoded lease borrowed and
sets `utility_epoch_retirement_required`; a late completion still returns that
lease, while a completion that never arrives makes in-process stop fail instead
of guessing that the pointer is safe.
