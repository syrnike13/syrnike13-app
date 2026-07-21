# ADR-0005 — Client diagnostic reports

- **Status:** Accepted
- **Date:** 2026-07-18
- **Revised:** 2026-07-19 — redacted reports are enabled by default
- **Implementation clarification:** 2026-07-21 — typed causal incidents and a
  single automatic trigger owner

## Context

Voice and screen-sharing failures often leave the application running, so crash
reports do not contain the state transitions and media statistics needed to
investigate them. Support also needs one authenticated place to find and
download a report instead of asking a user to locate several local log files.

## Decision

Web and desktop clients keep a bounded in-memory stream of structured diagnostic
events. Redacted diagnostic collection and automatic upload are enabled by
default and are triggered for fatal renderer errors, typed voice or media
failures, and a stalled local screen publication. The version 3 desktop settings
and version 2 browser preference migrations enable reports once for existing
installations; a later explicit opt-out remains durable. A user can also send a
report manually from settings. Repeated automatic reports for the same area and
trigger are limited by a client cooldown and a server rate limit.

Automatic upload classification is based on typed Diagnostic Incidents, not
regex matching against log text. The incident identity includes the stable
failure family and the available runtime, media kind, lane, stage, and causal
correlation. Low-level request, recycle, Runtime Loss, and Voice Session
projection records attach bounded evidence and occurrence counts to the same
incident.

On desktop, Electron main owns pending incidents, deduplication, cooldown, and
upload leases across renderer reloads. The authenticated renderer is an upload
executor: it adds the renderer ring and acknowledges or releases the lease, but
does not independently decide to create a second automatic report. Manual
reports remain explicit user actions and do not consume automatic cooldown.
This ownership is scoped to the authenticated account in memory: logout or an
account switch retires every pending incident, lease, cooldown, retry, and
fingerprint before a new renderer may upload, while a token refresh for the same
account preserves the current state. The account identity is never serialized
into the diagnostic bundle.

The Windows desktop main process also treats native request errors and timeouts,
queue exhaustion, out-of-order control events, degraded states, unexpected
utility exits, restarts, recycling, incompatibility, contract corruption, and
bootstrap/disposal failures as incidents. It queues sanitized incident summaries
until the authenticated renderer is ready; the renderer drains them every two
seconds and sends a report without prompting. Identical incidents are collapsed
for five seconds, and native automatic uploads use a one-minute client cooldown
so a restart loop cannot create an unbounded upload storm.

The event sanitizer removes credentials, URLs, filesystem paths, network
addresses, device labels, and user, room, channel, or participant identifiers.
Chat content and media content are never collected. Desktop reports include up
to 30 MiB from the three latest native media JSONL sessions. The budget is shared
fairly between Electron main, utility, and C++ native files so one noisy source
cannot displace the others. Changing this setting requires an application
restart.

Every JSONL line uses the versioned `syrnike.diagnostic` envelope with a record
type, timestamp, source, event name, and object payload. The first record is a
manifest whose metadata must match the authenticated upload request. Desktop
bundle creation normalizes legacy native log lines into this envelope before
upload.

The client caps the normalized desktop bundle at 33 MiB, gzip-compresses it,
and reduces the selected native record tails if the gzip output would exceed
10 MiB. It then sends the bundle through an authenticated backend endpoint.
The backend independently applies the same compressed ceiling and a 34 MiB
decompressed ceiling, fully decodes the gzip stream, validates every envelope,
and only then permits
storage. It creates a short-lived `pending` database record before uploading the
encrypted object and marks it `available` after S3 returns the encryption IV.
Privileged admin endpoints only expose available reports.

Available reports expire after 30 days, while incomplete pending uploads expire
after one hour. The cron daemon removes the storage object before deleting either
kind of database record and keeps running after transient database or storage
failures, so cleanup remains discoverable and retryable.

## Consequences

- The configured files bucket receives encrypted diagnostic objects, so no new
  object-storage credentials or deployment service are required.
- Browser reports contain the bounded renderer event stream, while desktop
  reports can additionally contain native voice and screen-sharing events.
- Every desktop bundle contains an inventory event with native session, source,
  byte, record, and truncation counts, so missing native coverage is visible in
  the report itself.
- Administrators can correlate reports with an account and release, but the
  downloadable bundle deliberately contains less identifying context.
- Adding a new automatic trigger requires a stable area and trigger code plus
  sanitized structured context; arbitrary console-log upload is not supported.

## Rejected alternatives

- Uploading all console output would expose unrelated application and user data
  while producing noisy reports without a stable schema.
- Removing the opt-out entirely would prevent users from stopping diagnostic
  collection after the one-time default-on migration.
- Storing diagnostic blobs in MongoDB would make retention and large downloads
  compete with operational metadata instead of using existing object storage.
