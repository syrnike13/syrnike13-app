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

The client gzip-compresses the JSONL bundle and sends it through an authenticated
backend endpoint. The backend validates metadata and compressed size, encrypts
the object through the existing files storage abstraction, and stores searchable
metadata linked to the authenticated account. Privileged admin endpoints list,
inspect, download, and update report status and notes.

Reports expire after 30 days. The cron daemon removes the storage object before
deleting its database record, so a transient storage failure remains retryable.

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
