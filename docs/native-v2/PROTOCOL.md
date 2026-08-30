# Windows native media protocol v2

`apps/desktop/src/main/media-runtime/contract.ts` is the production source of truth for every Electron main/utility message. It defines the Effect Schema codecs, inferred TypeScript types, exact protocol version, queue capacities, deadlines, and payload bounds. The native build generates `protocol_limits.generated.hpp` from those exported constants and uses the same values in the artifact manifest and verifier. The C++ representation is checked through native revision tests plus the Electron TS -> utility -> addon -> C++ -> addon -> utility -> TS golden round trip.

```text
Electron main                              C++ control thread
  request v2 + requestId + deadlineMs        validate complete snapshot
    -> utility host Schema decode               -> compare revision
      -> N-API strict field decode                 -> atomically store or reject
      <- typed addon result                        <- coherent snapshot
    <- reply v2 with same requestId

C++ public callback -> lossless public TSFN -> utility Schema -> Electron event
C++ diagnostic callback -> lossy diagnostic TSFN -> utility Schema -> diagnostic
```

## Commands and state

The only control commands are `handshake`, `applyDesiredState`, `querySnapshot`, `ping`, and `shutdown`. `requestId` correlates one reply and has no ordering, replay, or deduplication meaning; `revision` is the only recency marker. `applyDesiredState` validates the complete snapshot before the C++ control thread takes the command commit lock. A caller that wins the deadline race marks the command cancelled, while a control thread that wins completes the already-committed result, so a timeout can never be followed by a late state mutation.

Revision handling is deterministic:

- A greater revision is accepted atomically; gaps are allowed because revisions represent recency, not a delivery count.
- The accepted revision with byte-for-field equivalent content returns `duplicate`, making replay idempotent.
- The accepted revision with different content returns `revision_conflict`.
- A lower revision returns `stale_revision`.

At protocol v2, microphone, camera, screen, output, and remote-video quality support only `off`. A room intent carries bounded logical identifiers but no URL, token, SDK handle, device identifier, HWND, HRESULT, GPU object, or N-API value. Supporting active media requires a later protocol version and does not change the meaning of v2.

## Versioning and limits

Version negotiation is exact: both sides require version `2`; any other value returns `protocol_incompatible`. There is no compatibility range or v1 fallback.

| Value | Bound |
| --- | ---: |
| Request ID | 256 UTF-16 code units in TypeScript; 256 bytes for native identifiers |
| Room/participant/publication identifier | 256 printable ASCII bytes |
| Remote video demands | 64 |
| Pending Electron requests / C++ control queue | 16 |
| Public event queue / diagnostic event queue | 64 each |
| Diagnostic metrics / implementation fields | 16 each |
| Diagnostic metric/field name | 64 |
| Diagnostic implementation value | 256 |
| Request deadline | 1–5000 ms; current native control operations use at most 1000 ms |

Public state and diagnostic messages use distinct schemas and distinct N-API queues. Public queue overflow terminates the isolated utility so Electron observes a fault instead of silently losing state; diagnostic overflow only drops telemetry. Diagnostics contain typed codes, bounded finite metrics, and redacted optional implementation fields, and no diagnostic callback can enqueue a command or mutate Engine state.

The utility host rejects excess properties recursively before calling N-API. The addon then probes only the fixed expected property set and preflights string byte lengths with raw N-API before allocation; it deliberately does not enumerate attacker-controlled property names. This keeps parser allocation bounded while the production path still enforces the exact object shape.

The Engine emits all four public variants. Lifecycle transitions emit `engineStateChanged`; deterministic fatal startup/control failures additionally emit `fatalEngineFailure`; the first accepted desired snapshot publishes one `roomStateChanged` and four `trackStateChanged` events, and later room presence changes emit another room event. Revisions that leave public state unchanged do not flood the lossless queue.
