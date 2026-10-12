# ADR 0008: Pin publisher-transceiver reuse in the LiveKit fork

## Status

Accepted as a narrow Phase B mitigation; broader profile compatibility remains a Phase C gate.

## Context

Repeated `publishTrack`/`unpublishTrack` in the pinned upstream SDK created a new publisher transceiver on every cycle. The process retained the associated WebRTC threads and handles, so the 30-cycle screen oracle grew by hundreds of resources even though every application track had been unpublished. The reproduction is `MEDIA_LAB_SCREEN_MODE=screen-cpu-repeat`: `.1` grows monotonically, while `.2` returns to its warmed handle/thread budget after every acknowledged unpublish.

## Decision

Release `v1.10.0-syrnike.2` keeps removed publisher transceivers in an `RtcSession`-local pool. A candidate may be reused only when its audio/video kind and ordered RID list match. Reuse restores encoding parameters, sender track, and `sendonly` direction; any restore failure stops that candidate and creates a new transceiver. Dropping the `RtcSession` drops both active and reusable maps, so a disconnected Room cannot lend a transceiver to a later Room.

The application pins the release commit and archive checksum. No application code may assume that reuse exists, inspect the pool, or use it as a production lifecycle boundary.

## Verification and remaining matrix

The application-level repeat oracle verifies the original same-profile leak and now preserves per-cycle resource evidence. The fork's patch chain has unit tests for media-kind separation and exact ordered-RID key compatibility. Before the production GPU sender is accepted, SDK/integration tests must additionally cover encoding restoration and fallback, codec preference changes, camera/screen transitions, simulcast/scalability changes, software/hardware encoder backends, E2EE, reconnect, and failure during restoration. A future fork rebase must re-run that matrix and either upstream the patch or record why the fork remains necessary.

## Consequences

The narrow leak is removed without making the CPU oracle a production sender. The fork carries a real behavioral delta from upstream, so upgrades must treat this patch as maintained SDK code rather than an incidental binding fix.
