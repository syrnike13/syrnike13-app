# Windows native media protocol v3

`packages/windows-media-engine/protocol/media-lifecycle.json` is the canonical protocol descriptor. The native build hashes it, generates C++ limits and required/optional field definitions in `protocol_limits.generated.hpp`, and generates the TypeScript identity, field maps, and canonical fixtures in `protocol.generated.ts`. Conformance tests validate requests, replies, failures, and all public-event variants against the Effect schemas and generated field order; the native smoke also compares deterministic C++ events byte-for-byte with the canonical fixtures. The utility rejects an addon whose handshake hash differs from its artifact manifest.

```text
Electron main -> utility host -> N-API addon -> Engine control thread
 request v3      exact Schema    bounded decode   atomic desired-state commit
 credential lease (private) --------------------> private credential store
 room intent (lease ID only) --------------------> non-blocking Room coordinator
```

The commands are `handshake`, `installCredentialLease`, `applyDesiredState`, `querySnapshot`, `ping`, and `shutdown`. `requestId` only correlates a reply, while `revision` orders immutable desired-state snapshots. A greater revision is accepted, an identical revision/content pair is a duplicate, the same revision with different content is a conflict, and a lower revision is stale. A deadline cannot be followed by an ambiguous late commit: the command stores its committed reply under the same commit mutex, so the caller never performs an unbounded post-deadline wait.

Room credentials cross Electron IPC only in `installCredentialLease`. The Engine stores at most four leases privately and consumes a lease when it starts one connection attempt; installing a missing lease also resumes an already accepted failed intent. Desired state contains only a bounded `credentialLeaseId`, and snapshots, public events, diagnostics, and manifests never contain a URL or token. Room reconciliation reports `off`, `connecting`, `connected`, `disconnecting`, or `failed`; microphone, camera, screen, output, and remote-video quality remain `off` in Phase A.

Public state and diagnostics have separate types and lanes. The addon keeps a bounded public-event buffer and schedules at most one Node TSFN dispatch; room/track state can coalesce, terminal lifecycle/failure events are retained, and a sequence gap makes the supervisor query one coherent snapshot. Diagnostic overflow remains lossy. Queue capacity is 64, control capacity and pending Electron requests are 16, identifiers are 256 printable ASCII bytes, remote demands are 64, credential URLs are 2048 bytes, tokens are 16384 bytes, and request deadlines are 1–5000 ms.

Compatibility is exact. Version, schema SHA-256, addon commit, N-API version, staged file hashes, and release identity must agree before readiness; there is no v1/v2 fallback.
