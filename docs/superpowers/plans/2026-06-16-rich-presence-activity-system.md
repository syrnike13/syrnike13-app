# Rich Presence Activity System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-off music presence branch with a universal Discord-like Activity system that supports realtime music/game activities and verified-game history.

**Architecture:** `Presence` remains availability only. `Activity` is a Discord-like user-visible activity payload owned by canonical Activity Source IDs such as `desktop:music` and `desktop:game`. Desktop canonicalizes raw detector results before publishing; the backend validates and fans out realtime slots with TTL, and durable history is created only for server-verified game identities.

**Tech Stack:** TypeScript packages (`packages/platform`, `apps/web`, `apps/desktop`), React/TanStack frontend, Electron preload/main IPC, Rust backend gateway events, Redis for realtime slots, primary backend database for verified game sessions.

---

### Task 1: Platform Activity Contract

**Files:**
- Create: `packages/platform/src/activity.ts`
- Modify: `packages/platform/src/activity.test.ts`
- Modify: `packages/platform/src/api.ts`
- Modify: `packages/platform/src/index.ts`

- [ ] Write failing tests for `normalizeActivity`, `normalizeActivityPatch`, Discord-like fields, source ID validation, unsafe URL stripping, and client-secret rejection.
- [ ] Run `pnpm --filter @syrnike13/platform test -- activity.test.ts --run`; expected failure: activity module exports do not exist.
- [ ] Add `Activity`, `ActivityPatch`, `ActivityType`, nested timestamps/assets/party/buttons types, and normalizers.
- [ ] Export the new types and normalizers from `packages/platform/src/index.ts`.
- [ ] Run the focused platform test and verify it passes.

### Task 2: Web Gateway And Sync Store

**Files:**
- Modify: `apps/web/src/features/events/gateway.ts`
- Modify: `apps/web/src/features/events/gateway.test.ts`
- Modify: `apps/web/src/features/sync/types.ts`
- Modify: `apps/web/src/features/sync/sync-store.ts`
- Modify: `apps/web/src/features/sync/sync-store.test.ts`

- [ ] Write failing gateway tests proving `activity(activityPatch)` queues the latest `UserActivityUpdate` per `activitySourceId`.
- [ ] Write failing sync-store tests proving `UserActivity` upserts and clears `activities[userId][activitySourceId]`, and offline users clear activities.
- [ ] Run focused web tests; expected failure: new gateway/store APIs do not exist.
- [ ] Implement generic activity send/receive paths.
- [ ] Remove music-only store state in favor of generic `activities`.
- [ ] Run focused web tests and verify they pass.

### Task 3: Desktop Activity Publishing

**Files:**
- Create: `apps/web/src/features/presence/activity-manager.tsx`
- Modify: `apps/web/src/features/auth/authed-gate.tsx`
- Modify: `apps/web/src/features/presence/music-presence-manager.tsx`
- Modify: `apps/web/src/features/presence/music-presence-manager.test.tsx`
- Add tests for desktop game activity conversion using overlay state.

- [ ] Write failing tests for converting music presence into `desktop:music` listening activity.
- [ ] Write failing tests for converting overlay game target into `desktop:game` playing activity and clearing when target disappears.
- [ ] Run focused tests; expected failure: generic activity publishing APIs do not exist.
- [ ] Implement a desktop Activity manager that listens to desktop music and overlay state, publishes canonical activity slots, and does not send unchanged payloads.
- [ ] Keep desktop internal detectors local; only publish `desktop:music` and `desktop:game`.
- [ ] Run focused tests and verify they pass.

### Task 4: Backend Gateway Contract

**Files:**
- Modify: `services/backend/crates/core/database/src/events/client.rs`
- Modify: `services/backend/crates/core/database/src/events/server.rs`
- Modify: `services/backend/crates/bonfire/src/websocket.rs`
- Add or modify backend tests in the same Rust modules.

- [ ] Write failing Rust serialization/deserialization tests for `UserActivityUpdate` and `UserActivity`.
- [ ] Run the narrow cargo tests; expected failure: activity event structs do not exist.
- [ ] Add Rust Activity structs matching the platform contract, excluding client-provided `secrets`.
- [ ] Handle `ClientMessage::UserActivityUpdate` in bonfire: touch session, apply system activity presence, publish realtime activity update to self and active server subscriptions.
- [ ] Run narrow cargo tests and verify they pass.

### Task 5: UI Rendering

**Files:**
- Create or replace: `apps/web/src/components/user/user-activity-card.tsx`
- Modify: `apps/web/src/components/user/user-global-profile-sidebar.tsx`
- Modify: `apps/web/src/components/user/user-profile-card.tsx`
- Modify: `apps/web/src/components/chat/channel-member-sidebar.tsx`
- Update existing music card tests to generic activity tests.

- [ ] Write failing UI tests for rendering listening activity with artwork/progress and playing activity with game title.
- [ ] Run focused web component tests; expected failure: `UserActivityCard` does not exist or store selectors are missing.
- [ ] Implement generic activity sorting and rendering with game > streaming > listening > watching > competing > custom > app-like.
- [ ] Replace music-specific UI entry points with generic activity cards.
- [ ] Run focused UI tests and verify they pass.

### Task 6: Verified Game History Skeleton

**Files:**
- Add backend history model/repository files in the existing backend database style after inspecting current database conventions.
- Modify bonfire activity handling to call history open/extend/close only when the activity has a server-verified game identity.
- Add backend tests for five-minute merge window.

- [ ] Inspect backend database model conventions before choosing file paths.
- [ ] Write failing tests for same user + same verified game + gap under five minutes continuing one historical session.
- [ ] Add minimal verified game history persistence primitives.
- [ ] Ensure unverified/likely game realtime activities do not create history.
- [ ] Run focused cargo tests and verify they pass.

### Task 7: Verification

**Files:**
- No new production files unless tests expose required fixes.

- [ ] Run `pnpm --filter @syrnike13/platform test -- activity.test.ts --run`.
- [ ] Run focused web tests touched by gateway, sync store, presence managers, and activity UI.
- [ ] Run focused desktop tests touched by overlay/music conversion.
- [ ] Run narrow backend cargo tests for gateway event serialization and history session merge.
- [ ] Run broader `pnpm web:test` if focused tests pass.
- [ ] Inspect `git diff` for leftover music-only APIs, tracked build artifacts, and accidental unrelated changes.
