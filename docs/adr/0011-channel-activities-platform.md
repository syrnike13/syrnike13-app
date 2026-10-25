# ADR-0011 — Channel Activities platform with a public SDK

- **Status:** Accepted
- **Date:** 2026-10-24
- **Supersedes:** ADR-0006

## Context

ADR-0006 shipped first-party Channel Activities whose rules lived in Rust
reducers inside Bonfire. Every application needed backend code, the client and
server catalogs had to be kept in sync by hand, there was no way to end an
activity for everyone, and idle instances expired while people still used them.

The product now needs a platform: external web applications embedded in voice
channels through a public SDK, with first-party applications built on exactly
the same SDK. The backend must stay ignorant of application rules.

## Decision

### Terms

- **Activity Application** — a registered web application. Only platform
  administrators register applications (admin panel); there is no public
  developer portal and no per-server allowlist.
- **Activity Origin** — `https://{application_id}.{activities domain}`, the only
  origin an application is ever loaded from.
- **Activity Instance** — one running application in one voice channel.
- **Activity Participant** — a voice member who joined the instance.
- **Activity Host** — the participant the backend designates to run
  authoritative application logic, if the application wants one.
- **Activity Frame** — the client UI that embeds an Activity Origin and bridges
  it to the backend.

### Application registry

Applications are stored in MongoDB (`activity_applications`): name,
description, icon, upstream `origin_url`, `url_mappings` (`prefix → target`),
`max_participants`, `first_party`, `enabled`, and a hashed client secret.
The API exposes enabled applications to clients together with the computed
`activity_url`; clients never build Activity Origins themselves.

### Activity proxy

Every Activity Origin is served by the `activity-proxy` service:

- `{application_id}.{activities domain}/` proxies to `origin_url`;
  `/.proxy/{prefix}/…` proxies to the matching `url_mappings` target, including
  WebSocket upgrades. Applications reach their own backends only this way.
- The proxy never forwards client IP addresses or our cookies upstream.
- It adds a Content-Security-Policy on top of the application's own:
  `frame-ancestors` lists only syrnike13 clients, and `connect-src` is limited to
  the Activity Origin itself.
- Disabling an application in the registry stops serving it immediately.
- Caddy terminates TLS for `*.activities.syrnike13.ru` and
  `*.activities.beta.syrnike13.ru` with on-demand certificates. The `ask` check
  only approves registered applications, so random subdomains cannot exhaust
  certificate rate limits.

Production and nightly run separate proxies with separate registries.

### Instance lifecycle

- A voice channel has at most one Activity Instance; events always carry the
  instance ID so several instances per channel can be added later.
- Starting requires current Voice Membership in the channel and the
  `UseActivities` channel permission. The starter becomes the first
  participant and the Activity Host.
- Only voice members may join. Leaving the voice channel leaves the instance.
- The Activity Host may end the instance for everyone; so may members with
  `ManageChannel`. An instance also ends when its last participant leaves.
- When the Activity Host leaves, the earliest remaining participant becomes
  the Activity Host.
- There is no inactivity expiry. Bonfire periodically reconciles instances
  with Voice Membership so missed leave events cannot keep an instance alive.
- Instances live in Redis with compare-and-set writes and a revision; clients
  drop events older than the revision they hold.

### Synchronization primitives

The backend never interprets application payloads. It offers:

- **Messages** — relay of bounded JSON payloads from one participant to all or
  selected participants. Ordered per sender, rate limited, not stored, and lost
  while the sender's gateway is disconnected.
- **Shared state** — one bounded JSON document per instance written with
  compare-and-set on its version. Late joiners and reloaded frames recover
  from it.
- **Activity Host** — a designated participant, so applications can run
  host-authoritative logic: others send intents as messages, the host applies
  rules and publishes results as messages and shared state.

Applications that need cheat resistance run their own backend behind
`url_mappings`.

### Persistent player data

Stored in MongoDB per `(application, server, user)`:

- a private bounded JSON document per player;
- named numeric scores with server leaderboards.

Writes made through the Activity Frame use the player's session and are
marked untrusted: a player can forge their own data, never anyone else's.
Writes made by an application backend with an access token are marked
trusted. Leaderboards expose the flag.

### Identity and authorization

`authorize({ scopes })` in the SDK asks the Activity Frame to show a consent
dialog (skipped for first-party applications) and returns a short-lived code.
The application backend exchanges the code and its client secret for an
access token scoped to `identify` and `storage`. Session tokens and gateway
access never reach the application.

### SDK and frame protocol

`@syrnike13/activity-sdk` is the only interface between an application and the
platform; first-party applications use it without private extensions.

- The Activity Frame loads the Activity Origin in an iframe with
  `allow-scripts allow-same-origin allow-forms allow-pointer-lock`. The
  distinct origin isolates applications from the client and from each other.
  Popups are not allowed; external links go through an SDK call that the
  client confirms with the user.
- The handshake transfers one `MessagePort`. The client accepts it only from
  the iframe's window and the expected Activity Origin; the SDK accepts it only
  from its parent window.
- The protocol is versioned. The SDK exposes context (user, channel, server,
  locale, theme, layout), participants, the Activity Host, messages, shared
  state, player data, scores, authorization, external links, leave, and end.
- Frames may be recreated at any time (focus, pop-out, reload). Applications
  must restore from shared state rather than assume a long-lived frame.

### Transport

All activity traffic uses the authenticated Bonfire gateway. LiveKit data
channels are not used: on Windows desktop the native media engine owns the
Room, and RTC recovery must not affect application state. Messages are
relayed through the server either way, so latency is comparable.

### Visibility

A summary (application, participants, Activity Host) is published to the
channel topic and included in `Ready`, so everyone who can see the channel
sees the running activity and who is in it. Messages and shared state go only
to participants.

### Client projection

The voice panel launcher starts activities. A running instance appears in the
Voice Stage as a tile with the same behaviour as a stream tile: grid, focus,
filmstrip, pop-out, mini-player, and participant list. Non-participants see a
join action instead of the frame. The channel sidebar shows the activity and
its participants.

While experimental, client entry points are gated by
`uiFeatureFlags.channelActivities` (nightly only). The backend has no flag.

## Consequences

- New applications need no backend changes: register, deploy, done.
- Host-authoritative and shared-state applications can be cheated by their
  own participants; untrusted scores are labelled.
- The activity proxy is a new service with its own deploy, TLS, and capacity.
- High-rate applications share capacity with the gateway; rate limits protect
  chat delivery. A dedicated activity socket can replace the transport without
  changing the SDK.
