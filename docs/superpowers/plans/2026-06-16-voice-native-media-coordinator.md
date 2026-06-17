# Voice Native Media Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make desktop screen share state become active only after the current LiveKit room observes the native screen publication, while preventing microphone setup from blocking screen starts.

**Architecture:** Add a focused publication observer and native media coordinator state in the web voice layer, then route UI flags through confirmed coordinator state instead of raw refs. Split the desktop native start queue by media kind so microphone and screen starts do not wait behind each other.

**Tech Stack:** React, TypeScript, Vitest, LiveKit client, Electron IPC, pnpm.

---

## File Structure

- Create `apps/web/src/features/voice/native-media-coordinator.ts`
  - Defines native publisher state types and pure reducer helpers.
  - Keeps logic testable without rendering `VoiceProvider`.
- Create `apps/web/src/features/voice/voice-publication-observer.ts`
  - Finds and waits for native screen publications in a LiveKit `Room`.
  - Depends only on LiveKit room/participant shape and identity helpers.
- Create `apps/web/src/features/voice/native-media-coordinator.test.ts`
  - Tests reducer behavior for pending, published, failed, stale, and stopped states.
- Create `apps/web/src/features/voice/voice-publication-observer.test.ts`
  - Tests current-room publication detection and stale operation behavior.
- Modify `apps/web/src/features/voice/native-screen-share-publish.ts`
  - Preserve sidecar start/stop behavior, but return enough identity/session information for observer confirmation.
- Modify `apps/web/src/features/voice/voice-provider.tsx`
  - Use coordinator state for `screenShareEnabled` and `screenShareStarting`.
  - Start native screen as `starting`, then mark published only after publication observer resolves.
  - Keep stale generation guards.
- Modify `apps/desktop/src/main/native-media-engine.ts`
  - Replace global `startSessionQueue` with per-kind queues.
- Modify `apps/desktop/src/main/native-media-engine.test.ts`
  - Add a source-level guard proving there is no single global queue for microphone and screen.

---

### Task 1: Add Native Media Coordinator State

**Files:**
- Create: `apps/web/src/features/voice/native-media-coordinator.ts`
- Create: `apps/web/src/features/voice/native-media-coordinator.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Add tests that assert the exact state transitions:

```ts
import { describe, expect, it } from 'vitest'

import {
  createInitialNativeMediaState,
  nativeMediaReducer,
} from './native-media-coordinator'

describe('native media coordinator', () => {
  it('keeps screen starting until publication is observed', () => {
    const initial = createInitialNativeMediaState()
    const starting = nativeMediaReducer(initial, {
      type: 'screen_start_requested',
      operationId: 'op-1',
      channelId: 'channel-1',
      requestId: 'request-1',
    })

    expect(starting.screen).toMatchObject({
      status: 'starting',
      operationId: 'op-1',
      channelId: 'channel-1',
      requestId: 'request-1',
      visibleInRoom: false,
    })
  })

  it('marks screen published only after current publication is observed', () => {
    const starting = nativeMediaReducer(createInitialNativeMediaState(), {
      type: 'screen_start_requested',
      operationId: 'op-1',
      channelId: 'channel-1',
      requestId: 'request-1',
    })

    const published = nativeMediaReducer(starting, {
      type: 'screen_publication_observed',
      operationId: 'op-1',
      channelId: 'channel-1',
      participantIdentity: 'user-1:desktop-native:screen',
      publicationSid: 'screen-publication-1',
    })

    expect(published.screen).toMatchObject({
      status: 'published',
      operationId: 'op-1',
      channelId: 'channel-1',
      participantIdentity: 'user-1:desktop-native:screen',
      publicationSid: 'screen-publication-1',
      visibleInRoom: true,
    })
  })

  it('ignores stale screen publication observations', () => {
    const starting = nativeMediaReducer(createInitialNativeMediaState(), {
      type: 'screen_start_requested',
      operationId: 'op-2',
      channelId: 'channel-2',
      requestId: 'request-2',
    })

    const unchanged = nativeMediaReducer(starting, {
      type: 'screen_publication_observed',
      operationId: 'op-1',
      channelId: 'channel-1',
      participantIdentity: 'user-1:desktop-native:screen',
      publicationSid: 'stale-publication',
    })

    expect(unchanged).toBe(starting)
  })

  it('clears native screen state on operation reset', () => {
    const starting = nativeMediaReducer(createInitialNativeMediaState(), {
      type: 'screen_start_requested',
      operationId: 'op-1',
      channelId: 'channel-1',
      requestId: 'request-1',
    })

    expect(nativeMediaReducer(starting, { type: 'reset' })).toEqual(
      createInitialNativeMediaState(),
    )
  })
})
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```sh
pnpm --filter @syrnike13/web test -- native-media-coordinator.test.ts
```

Expected: FAIL because `native-media-coordinator.ts` does not exist.

- [ ] **Step 3: Implement reducer**

Create `native-media-coordinator.ts` with exported state types, `createInitialNativeMediaState`, and `nativeMediaReducer`. The reducer must return the same object for stale observations.

- [ ] **Step 4: Run tests and confirm they pass**

Run:

```sh
pnpm --filter @syrnike13/web test -- native-media-coordinator.test.ts
```

Expected: PASS.

---

### Task 2: Add LiveKit Publication Observer

**Files:**
- Create: `apps/web/src/features/voice/voice-publication-observer.ts`
- Create: `apps/web/src/features/voice/voice-publication-observer.test.ts`

- [ ] **Step 1: Write failing observer tests**

Add tests for finding a native screen publication:

```ts
import { Track } from 'livekit-client'
import { describe, expect, it } from 'vitest'

import { findNativeScreenPublication } from './voice-publication-observer'

function publication(sid: string, source = Track.Source.ScreenShare) {
  return { sid, trackSid: sid, source, isMuted: false }
}

function participant(identity: string, publications: unknown[]) {
  return {
    identity,
    trackPublications: new Map(
      publications.map((entry, index) => [`pub-${index}`, entry]),
    ),
  }
}

describe('voice publication observer', () => {
  it('finds native screen publication for the current user', () => {
    const room = {
      remoteParticipants: new Map([
        [
          'native-screen',
          participant('user-1:desktop-native:screen', [
            publication('screen-pub-1'),
          ]),
        ],
      ]),
    }

    expect(
      findNativeScreenPublication(room as never, {
        userId: 'user-1',
        nativeParticipantIdentity: 'user-1:desktop-native:screen',
      }),
    ).toMatchObject({
      participantIdentity: 'user-1:desktop-native:screen',
      publicationSid: 'screen-pub-1',
    })
  })

  it('ignores native screen publications for another user', () => {
    const room = {
      remoteParticipants: new Map([
        [
          'native-screen',
          participant('user-2:desktop-native:screen', [
            publication('screen-pub-2'),
          ]),
        ],
      ]),
    }

    expect(
      findNativeScreenPublication(room as never, {
        userId: 'user-1',
        nativeParticipantIdentity: 'user-1:desktop-native:screen',
      }),
    ).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```sh
pnpm --filter @syrnike13/web test -- voice-publication-observer.test.ts
```

Expected: FAIL because observer module does not exist.

- [ ] **Step 3: Implement observer helper**

Create `findNativeScreenPublication(room, options)`. It should iterate `room.remoteParticipants.values()`, require exact `nativeParticipantIdentity`, require `baseVoiceIdentity(identity) === userId`, and require `publication.source === Track.Source.ScreenShare`.

- [ ] **Step 4: Run tests and confirm they pass**

Run:

```sh
pnpm --filter @syrnike13/web test -- voice-publication-observer.test.ts
```

Expected: PASS.

---

### Task 3: Wire Screen UI State Through Confirmed Publication

**Files:**
- Modify: `apps/web/src/features/voice/voice-provider.tsx`
- Modify: `apps/web/src/features/voice/voice-provider-speaking-boundary.test.ts`

- [ ] **Step 1: Add source-level failing guards**

Extend `voice-provider-speaking-boundary.test.ts` with assertions that `screenShareEnabled` is not derived directly from `nativeScreenShareRef.current`, and that `findNativeScreenPublication` is used.

- [ ] **Step 2: Run test and confirm it fails**

Run:

```sh
pnpm --filter @syrnike13/web test -- voice-provider-speaking-boundary.test.ts
```

Expected: FAIL while `setScreenShareEnabled(localMedia.screensharing || Boolean(nativeScreenShareRef.current))` still exists.

- [ ] **Step 3: Update provider state**

Import coordinator helpers and observer. Add `nativeMediaState` state, reset it in `resetVoiceState` and `disconnectNativeMediaForHandoff`, dispatch `screen_start_requested` when screen share begins, dispatch `screen_publication_observed` only after observer finds the publication, and derive `screenShareEnabled` from `nativeMediaState.screen.visibleInRoom`.

- [ ] **Step 4: Keep stop behavior explicit**

When native screen stops, dispatch `screen_stopped`, clear `nativeScreenShareRef.current`, reset native stats, and sync participants.

- [ ] **Step 5: Run provider tests**

Run:

```sh
pnpm --filter @syrnike13/web test -- voice-provider-speaking-boundary.test.ts native-screen-share-publish.test.ts
```

Expected: PASS.

---

### Task 4: Split Desktop Native Start Queues

**Files:**
- Modify: `apps/desktop/src/main/native-media-engine.ts`
- Modify: `apps/desktop/src/main/native-media-engine.test.ts`

- [ ] **Step 1: Add source-level queue guard**

Add a test that reads `native-media-engine.ts` and expects `startSessionQueues` or equivalent per-kind queue storage. Also assert the old single `let startSessionQueue` declaration is gone.

- [ ] **Step 2: Run test and confirm it fails**

Run:

```sh
pnpm --filter @syrnike13/desktop test -- native-media-engine.test.ts
```

Expected: FAIL until the queue is split.

- [ ] **Step 3: Implement per-kind queues**

Replace:

```ts
let startSessionQueue: Promise<unknown> = Promise.resolve()
```

with:

```ts
const startSessionQueues: Record<NativeMediaSessionKind, Promise<unknown>> = {
  microphone: Promise.resolve(),
  screen: Promise.resolve(),
}
```

Use `startSessionQueues.screen` for screen prepare/start and `startSessionQueues.microphone` for microphone start. Keep `cancelPendingMediaStarts(kind)` behavior.

- [ ] **Step 4: Run desktop tests**

Run:

```sh
pnpm --filter @syrnike13/desktop test -- native-media-engine.test.ts
```

Expected: PASS.

---

### Task 5: Verification

**Files:**
- No new files unless tests reveal gaps.

- [ ] **Step 1: Run targeted web tests**

Run:

```sh
pnpm --filter @syrnike13/web test -- native-media-coordinator.test.ts voice-publication-observer.test.ts native-screen-share-publish.test.ts voice-provider-speaking-boundary.test.ts native-microphone-publish.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run targeted desktop tests**

Run:

```sh
pnpm --filter @syrnike13/desktop test -- native-media-engine.test.ts
```

Expected: PASS.

- [ ] **Step 3: Build web**

Run:

```sh
pnpm web:build
```

Expected: PASS.

- [ ] **Step 4: Manual repro**

Run the app with local backend/desktop setup. With two accounts joined to the same voice channel, start screen share during voice connection. Expected: the local bottom panel stays in starting state until the second account can see the stream; no ghost active screen remains after rapid channel switching.
