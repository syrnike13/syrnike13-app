# ADR-0004 — Backend-authoritative Authorization Snapshots

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

Rust authorizes requests from effective server, channel, group, direct-message,
voice, membership, relationship, ownership, privileged, timeout, and override
state. The web client independently reconstructs part of that policy and exposes
its plumbing to dozens of callers, which has already caused server-level rights
to be used for a channel-level action.

## Decision

The backend is the only authority that computes current-account Effective
Permissions. Gateway Ready and authorization-change events carry a revisioned
Authorization Snapshot of effective bitsets for every visible server, channel,
known user scope, and account-wide capability. The web client replaces this
projection atomically and a single Authorization Module turns it into named
Capabilities, including target-relative member and voice actions.

Permission Sources remain available for editing and audit display. A separate
Permission Draft evaluator may simulate proposed changes, but its output can
never authorize interface actions.

Every source event that can change Effective Permissions and its replacement
snapshot are delivered in the same gateway Bulk. The sync store applies that
Bulk in one notification batch, so UI callers never observe a new source with
an old authorization revision or the reverse.

Migration is a one-shot cutover: all access-control callers move to the new
module and the old client evaluator is deleted. There is no feature flag,
dual-path comparison, compatibility fallback, or surface-by-surface runtime.

## Consequences

- Backend route checks remain final and snapshots control only interface
  visibility and enabled state.
- Permission mutations must publish a fresh snapshot revision before clients
  expose the new capabilities.
- The gateway contract and sync store gain explicit authorization state.
- Rust and TypeScript share generated bit definitions, while policy ordering
  remains only in Rust.

## Rejected alternatives

- Keeping a TypeScript evaluator preserves two competing policy implementations.
- Sending only named UI booleans couples backend policy to current interface
  composition and duplicates the effective bitsets.
- A staged runtime migration permits old and new authorization paths to disagree.
