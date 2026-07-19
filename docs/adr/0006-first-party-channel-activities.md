# ADR-0006 — First-party Channel Activities over authoritative voice membership

- **Status:** Accepted
- **Date:** 2026-07-19

## Context

The product needs cooperative web applications that people can use together
while they occupy the same voice channel. The first delivery contains only
applications owned and shipped by syrnike13; third-party manifests, OAuth,
network proxies, public discovery, and untrusted hosting are outside scope.

Web voice exposes a browser LiveKit Room, while Windows desktop owns its Room in
the Native Media Session and does not expose it to the renderer. Making Channel
Activities depend directly on LiveKit data packets would therefore create two
client behaviours and would couple application state recovery to RTC recovery.

## Decision

### Channel Activity is a separate domain

Voice Authority remains the only owner of Voice Membership. A Channel Activity
may read that membership to authorize start, join, and command operations, but
it does not mutate Voice Intent, Voice Operations, RTC Engine state, or Media
Tracks.

One voice channel has at most one active Activity Instance. The instance stores
an application ID, participant IDs, owner ID, monotonically increasing revision,
application-defined JSON state, and a bounded lifetime in Redis.

### Server-authoritative application reducers

Embedded applications send typed Activity Commands rather than replacement
state. A registered first-party reducer validates each command and produces the
next state. Redis compare-and-set protects concurrent commands from different
Bonfire connections, and every accepted mutation increments the instance
revision.

All mutating requests verify the caller's current committed Voice Membership in
the target channel. Leaving an Activity is allowed after Voice Membership ends
so clients can clean up during voice teardown.

### Logical transport seam before physical separation

The first vertical slice carries the isolated Channel Activity protocol over
the existing authenticated gateway connection and publishes snapshots only to
current voice-channel members. Activity Commands are never queued while the
gateway is disconnected; clients resynchronize snapshots after reconnect.

The protocol, client service, and storage module do not depend on chat sync
state. If high-frequency applications require separate capacity later, the same
messages can move to a dedicated Activity WebSocket without changing embedded
applications or their MessageChannel SDK.

### Sandboxed first-party iframe

The Activity Host renders same-origin first-party applications in an iframe
with scripts enabled and an opaque sandbox origin. A transferred MessageChannel
is the only application bridge. It provides context, theme tokens, snapshots,
commands, and close; it never exposes the authenticated gateway, session token,
Voice Director, or desktop preload API.

## Consequences

- Web and Windows desktop share one Channel Activity implementation because the
  renderer transport is independent from the platform RTC Engine.
- Reconnect and late join use server snapshots instead of replaying LiveKit data
  packets.
- Every first-party application needs a registered server reducer and a static
  iframe entry point.
- The existing gateway is sufficient for party and turn-based applications,
  but action applications with continuous high-rate input may require the
  planned physical transport split.
