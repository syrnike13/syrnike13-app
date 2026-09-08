# Windows native media protocol v4

`packages/windows-media-engine/protocol/media-lifecycle.json` is the canonical protocol descriptor. The native build hashes it, generates C++ limits and required/optional field definitions in `protocol_limits.generated.hpp`, and generates the TypeScript identity, field maps, and canonical fixtures in `protocol.generated.ts`. `protocol:generate` updates both generated files, while the non-mutating `protocol:check` fails CI if either output is stale. Conformance tests validate requests, replies, failures, and all public-event variants against the Effect schemas and generated field order; the native smoke also compares deterministic C++ events byte-for-byte with the canonical fixtures. The utility rejects an addon whose handshake hash differs from its artifact manifest.

```text
Electron main -> utility host -> N-API addon -> Engine control thread
 request v4      exact Schema    bounded decode   atomic desired-state commit
 credential lease (private) --------------------> private credential store
 room intent (lease ID only) --------------------> non-blocking Room coordinator
```

The commands are `handshake`, `installCredentialLease`, `applyDesiredState`, `querySnapshot`, `ping`, and `shutdown`. `requestId` only correlates a reply, while `revision` orders immutable desired-state snapshots. A greater revision is accepted, an identical revision/content pair is a duplicate, the same revision with different content is a conflict, and a lower revision is stale. A deadline cannot be followed by an ambiguous late commit: the command stores its committed reply under the same commit mutex, so the caller never performs an unbounded post-deadline wait.

Room credentials cross Electron IPC only in `installCredentialLease`. The Engine stores at most four leases privately and consumes a lease when it starts one connection attempt; installing a missing lease also resumes an already accepted failed intent. Desired Room and participant identities travel with the private connect request and must match LiveKit's post-connect authority before `connected` is published. A mismatch disconnects the unexpected Room, emits non-retryable `room_authority_mismatch`, and retires the utility epoch without replaying its consumed lease. Desired state contains only a bounded `credentialLeaseId`, and snapshots, public events, diagnostics, and manifests never contain a URL or token. Room reconciliation reports `off`, `connecting`, `connected`, `disconnecting`, or `failed`; microphone, camera, screen, output, and remote-video quality remain `off` in Phase A.

Public state and diagnostics have separate types and lanes. The addon keeps a bounded public-event buffer and schedules at most one Node TSFN dispatch; room/track state can coalesce, terminal lifecycle/failure events are retained, and a sequence gap makes the supervisor query one coherent snapshot. Diagnostic overflow remains lossy. Queue capacity is 64, control capacity and pending Electron requests are 16, identifiers are 256 printable ASCII bytes, remote demands are 64, credential URLs are 2048 bytes, tokens are 16384 bytes, and request deadlines are 1–5000 ms.

Compatibility is exact. Version, schema SHA-256, addon commit, N-API version, staged file hashes, and release identity must agree before readiness; there is no v1/v2 fallback.

The descriptor's `mediaModels` section generates the media intent Effect schemas,
C++ value types and validators, and N-API read/write codecs. Active intent fields
are required; `off` contains only its discriminant. Nullable device IDs mean
follow-default, while explicit IDs remain opaque. Numeric and array bounds are
shared across both decoders and the native control validation. Other lifecycle
envelopes retain their explicit codecs and generated field lists.

Microphone controls retain the Voice Director range: linear gain 0–4 and
manual gate threshold −100–0 dBFS. Each output override list holds at most 1024
identities, the union of independently bounded 512-key volume and mute maps.
Microphone and screen-audio overrides are independent; each source gain (0–3)
multiplies the output gain (0–3) before the native stereo peak limiter.

Installing credentials discards superseded unreferenced leases, retaining the
lease referenced by the accepted Room intent and the incoming lease. Cancelled
connects cannot accumulate abandoned credentials until the private store fills.

Protocol v4 carries microphone warm/publication demand and DSP settings, camera
publication/profile/renderer preview demand, exact screen preset and independent
audio mode, output/deafen and bounded mixing controls. Explicit media retry
revisions travel inside the atomic desired snapshot. They do not authorize a
Room reconnect. Renderer IDs scope preview demand; replacing a renderer must
not change the publication intent. Bitrate adaptation remains native-owned and
never rewrites the selected screen dimensions or target FPS.

Explicit audio and camera device IDs are stable opaque hashes of the native
endpoint identity, with separate input, output, and camera namespaces. A new
utility resolves the same endpoint to the same ID; a removed endpoint cannot
alias another device merely because enumeration order changed. Hash failures
and collisions fail enumeration rather than selecting a different endpoint.
The native endpoint strings never cross the protocol boundary.

Screen source IDs instead belong to one registry lifetime. Renderer reload and
Room reconnect preserve that registry, but utility replacement invalidates its
source IDs. Replaying an expired screen selection reports non-retryable
`screen_source_unavailable`; the user must select a source again. The runtime
does not reconstruct a selection from a window title or recycled Win32 handle.
