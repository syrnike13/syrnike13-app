# Voice Native Media Coordinator Design

## Problem

Desktop voice media currently has several competing sources of truth:

- `Room` connection state says the user is in LiveKit.
- Native media helpers say microphone or screen sidecars have started.
- `voice-provider.tsx` refs such as `nativeScreenShareRef` say a local helper exists.
- `stageMediaItems` says the current LiveKit room actually exposes visible media.

This lets the UI show "screen share is active" when the current room has not yet observed a live screen publication from the native screen participant. It also lets screen share starts race with voice channel switching and native microphone setup.

The fix should make UI state follow confirmed media publication, not helper existence.

## Goals

- Screen share is shown as active only after the current LiveKit room observes the native screen publication.
- Starting screen share while voice is still connecting is deterministic: it becomes a pending intent or a starting state, not a fake active state.
- Switching channels cancels stale native starts and prevents late results from mutating the new room state.
- Microphone setup failure or slowness must not leave the whole voice session in an ambiguous state.
- The implementation should shrink `voice-provider.tsx` responsibility instead of adding more scattered guards.

## Non-Goals

- Do not redesign backend voice membership. The backend already stores join intent and filters stale native participants.
- Do not treat Windows native helper crashes as the main input to this design.
- Do not add backwards compatibility APIs unless explicitly requested.

## Architecture

Introduce a `NativeMediaCoordinator` in the web voice layer. It owns the lifecycle of native microphone and native screen publishers for the current voice operation.

The coordinator receives:

- current `operationId`
- current `channelId`
- current LiveKit `Room`
- native LiveKit credentials
- user media intent: microphone wanted, screen wanted

The coordinator exposes explicit state:

```ts
type NativePublisherState =
  | { status: 'idle' }
  | { status: 'starting'; operationId: string; channelId: string }
  | {
      status: 'published'
      operationId: string
      channelId: string
      participantIdentity: string
    }
  | { status: 'stopping'; operationId: string; channelId: string }
  | { status: 'failed'; operationId: string; channelId: string; error: string }

type NativeScreenState = NativePublisherState & {
  visibleInRoom?: boolean
  publicationSid?: string
}

type VoiceMediaState = {
  microphone: NativePublisherState
  screen: NativeScreenState
}
```

`voice-provider.tsx` should derive UI flags from this state:

```ts
screenShareEnabled =
  media.screen.status === 'published' && media.screen.visibleInRoom === true

screenShareStarting =
  media.screen.status === 'starting'
```

`nativeScreenShareRef.current` must no longer make screen share appear active by itself.

## Publication Observer

Add a small `VoicePublicationObserver` responsible for watching the current LiveKit room.

For native screen share, success requires a remote participant whose identity matches the native screen identity and whose base identity is the current user. The observer waits for a `Track.Source.ScreenShare` publication in the current room.

The observer emits:

- `screen-visible` when the publication appears in the current room
- `screen-hidden` when the publication disappears
- `stale` when the room, channel, or operation changes

The coordinator uses these events to move screen state from `starting` to `published`.

## Start Flow

Voice join:

1. `VoiceSessionController` creates an operation.
2. `room.connect` completes.
3. `NativeMediaCoordinator` starts native microphone according to preferences.
4. Voice can become connected once the room is usable and local media state is resolved.

Screen share:

1. User clicks screen share.
2. If room/local voice is not ready, coordinator records pending screen intent and exposes `screen.status = 'starting'`.
3. When the current operation is ready, coordinator starts native screen helper.
4. Desktop returns native session info.
5. Observer waits until the current LiveKit room sees the native screen publication.
6. Only then the UI shows screen share as active.

Channel switch:

1. A new operation invalidates the previous operation.
2. Coordinator cancels pending starts and stops active native publishers for the old operation.
3. Late success from an old helper is stopped and ignored.

## Desktop Queue

The desktop native media engine should stop using one global `startSessionQueue` for both microphone and screen.

Use separate queues by media kind:

- microphone starts serialize with microphone starts
- screen starts serialize with screen starts and screen preconnect
- screen does not wait behind microphone setup

This prevents "start screen during connecting microphone" from turning into a long hidden queue.

## Error Handling

- Screen start failure clears `screen.status` to `failed` and leaves voice connected.
- Microphone start failure marks microphone failed/muted, but does not make the whole room ambiguous.
- Stale operations do not toast as user-visible errors; they are expected during switching.
- Real current-operation failures can toast once.

## Testing

Add focused tests for:

- native screen helper success does not set `screenShareEnabled` until LiveKit publication is observed
- screen share clicked during `localVoiceReady=false` becomes pending/starting, not active
- stale screen start result after channel switch is stopped and ignored
- microphone and screen starts do not share one desktop queue
- existing stale native microphone guards still pass

## Verification

A fix is complete only when:

- two-account local repro shows screen share visible to the other account
- bottom panel never shows active screen share before the other account can observe the publication
- rapid channel switching does not leave a ghost screen share control
- targeted web and desktop tests pass
- `pnpm web:build` passes
