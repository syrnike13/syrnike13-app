# ADR-0005 — Client diagnostic reports

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

Voice and screen-sharing failures often leave the application running, so crash
reports do not contain the state transitions and media statistics needed to
investigate them. Support also needs one authenticated place to find and
download a report instead of asking a user to locate several local log files.

## Decision

Web and desktop clients keep a bounded in-memory stream of structured diagnostic
events. Automatic upload is opt-in and is triggered for fatal renderer errors,
typed voice or media failures, and a stalled local screen publication. A user can
also send a report manually from settings. Repeated automatic reports for the
same area and trigger are limited by a client cooldown and a server rate limit.

The event sanitizer removes credentials, URLs, filesystem paths, network
addresses, device labels, and user, room, channel, or participant identifiers.
Chat content and media content are never collected. Desktop reports may include
the latest bounded native media JSONL sessions when the same opt-in has enabled
native diagnostics; changing this setting requires an application restart.

Every JSONL line uses the versioned `syrnike.diagnostic` envelope with a record
type, timestamp, source, event name, and object payload. The first record is a
manifest whose metadata must match the authenticated upload request. Desktop
bundle creation normalizes legacy native log lines into this envelope before
upload.

The client gzip-compresses the JSONL bundle and sends it through an authenticated
backend endpoint. The backend applies compressed and decompressed size limits,
fully decodes the gzip stream, validates every envelope, and only then permits
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
- Administrators can correlate reports with an account and release, but the
  downloadable bundle deliberately contains less identifying context.
- Adding a new automatic trigger requires a stable area and trigger code plus
  sanitized structured context; arbitrary console-log upload is not supported.

## Rejected alternatives

- Uploading all console output would expose unrelated application and user data
  while producing noisy reports without a stable schema.
- Enabling automatic collection by default would make the privacy decision
  implicit and could start native logging without the user's consent.
- Storing diagnostic blobs in MongoDB would make retention and large downloads
  compete with operational metadata instead of using existing object storage.
