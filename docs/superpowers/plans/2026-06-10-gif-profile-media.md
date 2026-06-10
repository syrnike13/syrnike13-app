# GIF Profile Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add animated GIF support for profile avatars and banners using original GIFs in approved UI states.

**Architecture:** Keep storage and preview generation unchanged. Centralize frontend URL/mode selection in `apps/web/src/lib/media.ts` and `UserAvatar`, then make targeted backend helper functions for GIF size limits and original response disposition.

**Tech Stack:** React, TypeScript, Vitest, Rust, Axum, pnpm, cargo.

---

### Task 1: Frontend URL Selection

**Files:**
- Modify: `apps/web/src/lib/media.ts`
- Test: `apps/web/src/lib/media.test.ts`

- [ ] Add helpers that detect animated GIF files and return original URL only when animation is enabled.
- [ ] Cover preview URL fallback for non-GIF, non-animated images, and null files.

### Task 2: Avatar Animation Modes

**Files:**
- Modify: `apps/web/src/components/user/user-avatar.tsx`
- Test: `apps/web/src/components/user/user-avatar.test.tsx`

- [ ] Add `animated?: 'never' | 'hover' | 'always' | 'speaking'`.
- [ ] Use preview by default, switch to original on hover/focus for `hover`.
- [ ] Use original only when `speaking` is true for `speaking`.
- [ ] Keep default mode as `hover` for existing small avatar uses.

### Task 3: Apply Large And Voice Modes

**Files:**
- Modify: `apps/web/src/components/user/user-profile-card-header.tsx`
- Modify: `apps/web/src/components/user/current-user-profile-menu.tsx`
- Modify: `apps/web/src/components/settings/settings-profile-panel.tsx`
- Modify: `apps/web/src/components/voice/voice-stage-media-tile.tsx`
- Modify: `apps/web/src/components/voice/voice-stage-tile.tsx`

- [ ] Pass `animated="always"` for large profile/avatar surfaces.
- [ ] Use animated banner URLs for large profile banners.
- [ ] Pass `animated="speaking"` and `speaking={speaking}` to voice stage avatar surfaces.

### Task 4: Backend GIF Limit And Original Disposition

**Files:**
- Modify: `services/backend/crates/services/autumn/src/api.rs`

- [ ] Move MIME detection before size-limit selection.
- [ ] Add helper for effective upload limit: 10 MB only for `image/gif` in `avatars` and `backgrounds`.
- [ ] Add helper for original content disposition: `inline` only for GIF originals in `avatars` and `backgrounds`.
- [ ] Add focused Rust unit tests for both helpers.

### Task 5: Verification

**Commands:**
- `pnpm --filter @syrnike13/web test`
- `pnpm --filter @syrnike13/web build`
- `cargo check --manifest-path services/backend/Cargo.toml --workspace`

- [ ] Run narrow tests first where available.
- [ ] Run broader checks after implementation.
- [ ] Report any environment failures with exact command and error.
