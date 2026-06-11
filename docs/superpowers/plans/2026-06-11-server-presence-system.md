# Server Presence System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move automatic idle/active presence from the web client to the backend while preserving manual statuses.

**Architecture:** Add persisted system-managed presence values, reject them from public profile edit APIs, and let the gateway update them from session activity. Store per-session activity in Redis so one inactive session cannot mark a user idle while another session is active.

**Tech Stack:** Rust backend crates (`models`, `database`, `presence`, `bonfire`, `delta`), React/TanStack web client, Vitest, pnpm, Cargo.

---

### Task 1: Presence Types And UI Mapping

**Files:**
- Modify: `services/backend/crates/core/models/src/v0/users.rs`
- Modify: `services/backend/crates/core/database/src/models/users/model.rs`
- Modify: `services/backend/crates/core/database/src/util/bridge/v0.rs`
- Modify: `packages/api-types/src/schema.ts`
- Modify: `apps/web/src/lib/presence.ts`
- Test: `apps/web/src/lib/presence.test.ts`

- [x] Add failing frontend tests for `SystemIdle`, `SystemWebOnline`, and `SystemMobileOnline` labels and selector exclusion.
- [x] Run `pnpm --dir apps/web test -- presence.test.ts --run` and verify the new tests fail because system statuses are unknown.
- [x] Add the three backend enum variants and bridge conversions.
- [x] Update generated TypeScript schema manually to include system variants.
- [x] Update frontend presence helpers so system statuses render like their user-facing state but do not appear in selectable options.
- [x] Run `pnpm --dir apps/web test -- presence.test.ts --run` and verify it passes.

### Task 2: API Validation For Manual Statuses

**Files:**
- Modify: `services/backend/crates/delta/src/routes/users/edit_user.rs`
- Test: `services/backend/crates/delta/src/routes/users/edit_user.rs`

- [x] Add a failing backend unit test proving system statuses are rejected for user edits.
- [x] Run the narrow Cargo test and verify it fails because validation does not exist.
- [x] Add a small explicit validator that accepts only manual statuses in `PATCH /users/@me`.
- [x] Run the narrow Cargo test and verify it passes.

### Task 3: Redis Session Activity

**Files:**
- Modify: `services/backend/crates/core/presence/src/lib.rs`
- Modify: `services/backend/crates/core/presence/src/operations.rs`

- [x] Add tests for session activity metadata helper functions where practical without requiring Redis-only behavior to be faked.
- [x] Add per-session metadata storage: client kind and last activity timestamp.
- [x] Add helper functions to touch a session, delete metadata, and detect whether any session is recently active.
- [x] Keep existing online set behavior intact.

### Task 4: Gateway System Presence Lifecycle

**Files:**
- Modify: `services/backend/crates/core/database/src/models/users/model.rs`
- Modify: `services/backend/crates/core/database/src/events/server.rs`
- Modify: `services/backend/crates/bonfire/src/config.rs`
- Modify: `services/backend/crates/bonfire/src/websocket.rs`
- Modify: `apps/web/src/features/events/gateway.ts`
- Modify: `apps/web/src/features/presence/activity-presence.ts`
- Modify: `apps/web/src/features/presence/activity-presence-manager.tsx`
- Test: `apps/web/src/features/presence/activity-presence.test.ts`

- [x] Add failing frontend tests proving the old client manager sends activity rather than PATCHing Idle/Online.
- [x] Add client activity gateway event and `client` query parameter.
- [x] Add backend `ClientMessage::UserActivity`.
- [x] On gateway connect and activity, update online-like/system-idle statuses to `SystemWebOnline`, `SystemMobileOnline`, or `Online`.
- [x] Periodically set `SystemIdle` only when all active sessions are older than the idle threshold.
- [x] Do not alter manual `Idle`, `Focus`, `Busy`, or `Invisible`.
- [x] Run frontend presence tests and backend check.

### Task 5: Full Verification

**Files:**
- No new files.

- [x] Run `pnpm web:test`.
- [x] Run `pnpm web:build`.
- [x] Run `pnpm backend:check`.
- [x] Inspect `git diff` for accidental broad refactors or generated noise.
