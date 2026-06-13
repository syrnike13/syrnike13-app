# Voice Handoff Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace destructive voice join/switch behavior with operation-based voice handoff so reconnects, channel switches, DM call answers, and native sidecar failures do not leave the user stuck outside voice.

**Architecture:** Introduce a pure voice session state machine and a controller that owns desired voice state, operation ids, retries, and stale-event rejection. Replace channel-only gateway matching with operation-aware commands, then move backend membership cleanup from prepare-time to LiveKit webhook commit-time.

**Tech Stack:** React, TypeScript, Vitest, LiveKit JS, Electron IPC, Rust backend, Redis voice intent state, LiveKit webhook ingress.

---

## Task 1: Pure Voice Session State Machine

**Files:**
- Create: `apps/web/src/features/voice/voice-session-machine.ts`
- Create: `apps/web/src/features/voice/voice-session-machine.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/features/voice/voice-session-machine.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  createInitialVoiceSessionState,
  reduceVoiceSession,
} from './voice-session-machine'

describe('voice session machine', () => {
  it('keeps the target channel as desired state when a handoff connect fails', () => {
    let state = createInitialVoiceSessionState()

    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-a',
      operationId: 'op-a',
      reason: 'manual_join',
    })
    state = reduceVoiceSession(state, {
      type: 'server_prepare_succeeded',
      operationId: 'op-a',
    })
    state = reduceVoiceSession(state, {
      type: 'room_connected',
      operationId: 'op-a',
    })
    state = reduceVoiceSession(state, {
      type: 'server_commit_observed',
      operationId: 'op-a',
      channelId: 'voice-a',
    })
    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-b',
      operationId: 'op-b',
      reason: 'switch',
    })
    state = reduceVoiceSession(state, {
      type: 'room_connect_failed',
      operationId: 'op-b',
      error: 'LiveKit timeout',
    })

    expect(state.desired).toEqual({
      kind: 'channel',
      channelId: 'voice-b',
      operationId: 'op-b',
      reason: 'switch',
    })
    expect(state.phase).toBe('failed_retrying')
    expect(state.connectedChannelId).toBe('voice-a')
    expect(state.lastError).toBe('LiveKit timeout')
  })

  it('lets the latest operation ignore stale success and failure events', () => {
    let state = createInitialVoiceSessionState()

    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-a',
      operationId: 'op-a',
      reason: 'manual_join',
    })
    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-b',
      operationId: 'op-b',
      reason: 'switch',
    })
    state = reduceVoiceSession(state, {
      type: 'server_prepare_succeeded',
      operationId: 'op-a',
    })
    state = reduceVoiceSession(state, {
      type: 'room_connect_failed',
      operationId: 'op-a',
      error: 'old operation failed',
    })

    expect(state.desired).toEqual({
      kind: 'channel',
      channelId: 'voice-b',
      operationId: 'op-b',
      reason: 'switch',
    })
    expect(state.phase).toBe('preparing')
    expect(state.lastError).toBeNull()
  })

  it('turns unexpected disconnects into reconnecting desired channel state', () => {
    let state = createInitialVoiceSessionState()

    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-a',
      operationId: 'op-a',
      reason: 'manual_join',
    })
    state = reduceVoiceSession(state, {
      type: 'server_commit_observed',
      operationId: 'op-a',
      channelId: 'voice-a',
    })
    state = reduceVoiceSession(state, {
      type: 'room_disconnected',
      expected: false,
      operationId: 'op-a',
      error: 'network lost',
    })

    expect(state.phase).toBe('reconnecting')
    expect(state.desired.kind).toBe('channel')
    expect(state.connectedChannelId).toBeNull()
    expect(state.lastError).toBe('network lost')
  })

  it('explicit leave cancels desired channel and stale joins cannot reconnect it', () => {
    let state = createInitialVoiceSessionState()

    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-a',
      operationId: 'op-a',
      reason: 'manual_join',
    })
    state = reduceVoiceSession(state, {
      type: 'leave_requested',
      operationId: 'op-leave',
    })
    state = reduceVoiceSession(state, {
      type: 'server_commit_observed',
      operationId: 'op-a',
      channelId: 'voice-a',
    })

    expect(state.desired).toEqual({ kind: 'none', operationId: 'op-leave' })
    expect(state.phase).toBe('leaving')
    expect(state.connectedChannelId).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```sh
pnpm --filter @syrnike13/web test -- voice-session-machine
```

Expected: FAIL because `voice-session-machine.ts` does not exist.

- [ ] **Step 3: Implement the minimal state machine**

Create `apps/web/src/features/voice/voice-session-machine.ts` with:

```ts
export type VoiceJoinReason = 'manual_join' | 'switch' | 'dm_answer' | 'rejoin'

export type DesiredVoiceSession =
  | { kind: 'none'; operationId: string | null }
  | {
      kind: 'channel'
      channelId: string
      operationId: string
      reason: VoiceJoinReason
    }

export type VoiceRuntimePhase =
  | 'idle'
  | 'preparing'
  | 'connecting_rtc'
  | 'waiting_server_commit'
  | 'publishing_native'
  | 'connected'
  | 'reconnecting'
  | 'failed_retrying'
  | 'leaving'

export type VoiceSessionState = {
  desired: DesiredVoiceSession
  phase: VoiceRuntimePhase
  connectedChannelId: string | null
  activeOperationId: string | null
  previousChannelId: string | null
  lastError: string | null
}

export type VoiceSessionEvent =
  | {
      type: 'join_requested'
      channelId: string
      operationId: string
      reason: VoiceJoinReason
    }
  | { type: 'leave_requested'; operationId: string }
  | { type: 'server_prepare_succeeded'; operationId: string }
  | { type: 'room_connected'; operationId: string }
  | { type: 'server_commit_observed'; operationId: string; channelId: string }
  | { type: 'native_publish_succeeded'; operationId: string }
  | { type: 'room_connect_failed'; operationId: string; error: string }
  | {
      type: 'room_disconnected'
      operationId: string
      expected: boolean
      error?: string
    }

export function createInitialVoiceSessionState(): VoiceSessionState {
  return {
    desired: { kind: 'none', operationId: null },
    phase: 'idle',
    connectedChannelId: null,
    activeOperationId: null,
    previousChannelId: null,
    lastError: null,
  }
}

export function reduceVoiceSession(
  state: VoiceSessionState,
  event: VoiceSessionEvent,
): VoiceSessionState {
  switch (event.type) {
    case 'join_requested':
      return {
        ...state,
        desired: {
          kind: 'channel',
          channelId: event.channelId,
          operationId: event.operationId,
          reason: event.reason,
        },
        phase: 'preparing',
        activeOperationId: event.operationId,
        previousChannelId: state.connectedChannelId,
        lastError: null,
      }

    case 'leave_requested':
      return {
        ...state,
        desired: { kind: 'none', operationId: event.operationId },
        phase: 'leaving',
        connectedChannelId: null,
        activeOperationId: event.operationId,
        previousChannelId: state.connectedChannelId,
        lastError: null,
      }

    case 'server_prepare_succeeded':
      if (event.operationId !== state.activeOperationId) return state
      return { ...state, phase: 'connecting_rtc', lastError: null }

    case 'room_connected':
      if (event.operationId !== state.activeOperationId) return state
      return { ...state, phase: 'waiting_server_commit', lastError: null }

    case 'server_commit_observed':
      if (event.operationId !== state.activeOperationId) return state
      return {
        ...state,
        phase: 'connected',
        connectedChannelId: event.channelId,
        previousChannelId: null,
        lastError: null,
      }

    case 'native_publish_succeeded':
      if (event.operationId !== state.activeOperationId) return state
      return state.phase === 'connected'
        ? state
        : { ...state, phase: 'connected', lastError: null }

    case 'room_connect_failed':
      if (event.operationId !== state.activeOperationId) return state
      return { ...state, phase: 'failed_retrying', lastError: event.error }

    case 'room_disconnected':
      if (event.operationId !== state.activeOperationId) return state
      if (event.expected) {
        return {
          ...state,
          phase: 'idle',
          connectedChannelId: null,
          activeOperationId: null,
          lastError: null,
        }
      }
      return {
        ...state,
        phase: 'reconnecting',
        connectedChannelId: null,
        lastError: event.error ?? 'Voice connection lost',
      }
  }
}
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```sh
pnpm --filter @syrnike13/web test -- voice-session-machine
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Run neighboring voice tests**

Run:

```sh
pnpm --filter @syrnike13/web test -- voice-session-machine voice-recovery voice-rejoin voice-gateway voice-join native-microphone-publish
```

Expected: PASS.

## Task 2: Voice Operation Id Helpers

**Files:**
- Create: `apps/web/src/features/voice/voice-operation.ts`
- Create: `apps/web/src/features/voice/voice-operation.test.ts`

- [ ] **Step 1: Write tests for operation id generation and stale matching**

Create tests that assert `createVoiceOperationId()` returns non-empty unique strings and `isCurrentVoiceOperation(current, incoming)` only accepts exact matches.

- [ ] **Step 2: Implement helper**

Use `crypto.randomUUID()` with a timestamp/random fallback and no external dependency.

- [ ] **Step 3: Run helper tests**

Run:

```sh
pnpm --filter @syrnike13/web test -- voice-operation
```

Expected: PASS.

## Task 3: Controller Skeleton

**Files:**
- Create: `apps/web/src/features/voice/voice-session-controller.ts`
- Create: `apps/web/src/features/voice/voice-session-controller.test.ts`

- [ ] **Step 1: Write tests for latest intent behavior**

Cover `requestJoin`, `requestLeave`, stale prepare response, and failed target retry state.

- [ ] **Step 2: Implement controller over the pure reducer**

Expose `getState()`, `subscribe(listener)`, `requestJoin(channelId, options)`, `requestLeave()`, and event handlers that delegate to `reduceVoiceSession`.

- [ ] **Step 3: Run controller tests**

Run:

```sh
pnpm --filter @syrnike13/web test -- voice-session-controller
```

Expected: PASS.

## Task 4: Operation-Aware Web Gateway

**Files:**
- Modify: `apps/web/src/features/voice/voice-gateway.ts`
- Modify: `apps/web/src/features/voice/voice-gateway.test.ts`

- [ ] **Step 1: Add failing tests for operation id matching**

Add tests that a voice server update for the same channel but different `operation_id` does not resolve the pending join.

- [ ] **Step 2: Replace channel-only matching with operation matching**

Change request/response matching from `channelId` to `operationId`.

- [ ] **Step 3: Split reliable keys**

Use semantic keys for flags and latest desired join. Do not let flag updates replace join commands.

## Task 5: Backend Handoff Prepare and Commit

**Files:**
- Modify: `services/backend/crates/bonfire/src/voice.rs`
- Modify: `services/backend/crates/core/database/src/voice/join.rs`
- Modify: `services/backend/crates/core/database/src/voice/mod.rs`
- Modify: `services/backend/crates/daemons/voice-ingress/src/api.rs`

- [ ] **Step 1: Add Rust tests for prepare not disconnecting previous voice**

Assert handoff prepare stores intent and returns credentials without calling `remove_user_from_all_rooms`.

- [ ] **Step 2: Add `operation_id` to voice join intent**

Persist target channel, previous channel, flags, recipients, and operation id.

- [ ] **Step 3: Commit move in `participant_joined`**

Only after target participant joins, remove previous channel membership and publish move.

## Task 6: React Provider Migration

**Files:**
- Modify: `apps/web/src/features/voice/voice-provider.tsx`
- Modify: `apps/web/src/features/voice/voice-context.ts`
- Modify: `apps/web/src/components/channels/channel-sidebar-item.tsx`
- Modify: `apps/web/src/components/voice/incoming-voice-call-overlay.tsx`

- [ ] **Step 1: Adapt UI calls to intent methods**

Replace direct destructive join assumptions with `requestJoin(channelId, { reason })`.

- [ ] **Step 2: Move retry state into controller**

Remove `joinBlockedUntilRef` and stop silently returning `false` for manual retry.

## Task 7: Native Publisher Isolation

**Files:**
- Create: `apps/web/src/features/voice/voice-native-publisher-controller.ts`
- Create: `apps/web/src/features/voice/voice-native-publisher-controller.test.ts`
- Modify: `apps/web/src/features/voice/native-microphone-publish.ts`
- Modify: `apps/web/src/features/voice/voice-provider.tsx`

- [ ] **Step 1: Add tests that sidecar loss does not leave voice**

Assert publisher failure transitions publisher state to retrying while session state remains connected.

- [ ] **Step 2: Refresh native credentials during publisher retry**

Use operation/channel from session controller and keep browser LiveKit room untouched.

## Task 8: Full Verification

**Files:**
- Modify: `apps/web/src/features/voice/*.test.ts`
- Modify: `apps/web/src/components/voice/*.test.tsx`
- Modify: `apps/web/src/components/channels/channel-sidebar-item.test.tsx`
- Modify: `services/backend/crates/core/database/tests/*.rs`

- [ ] **Step 1: Run web tests**

```sh
pnpm web:test
```

- [ ] **Step 2: Run web build**

```sh
pnpm web:build
```

- [ ] **Step 3: Run desktop tests**

```sh
pnpm --filter @syrnike13/desktop test -- native-media-engine
```

- [ ] **Step 4: Run backend check**

```sh
pnpm backend:check
```
