import { describe, expect, it, vi } from 'vitest'
import { createInitialVoiceMediaDesiredState, type VoiceEngineEvent, type VoiceLease, type VoiceMediaDesiredState } from '@syrnike13/platform'
import {
  MEDIA_LIFECYCLE_PROTOCOL_VERSION,
  MEDIA_LIFECYCLE_SCHEMA_SHA256,
  createInactiveMediaPaths,
  mediaLifecycleError,
  type EngineDesiredState,
  type MediaCredentialLease,
  type MediaDesiredStateAccepted,
  type MediaEngineSnapshot,
  type MediaLifecycleEvent,
  type MediaLifecycleReady,
} from '../media-runtime/contract'
import type { MediaRuntimeSupervisorSnapshot } from '../media-runtime/media-runtime-supervisor'
import { NativeRtcEngineAdapterV2 } from './native-rtc-engine-adapter-v2'

const lease: VoiceLease = {
  channelId: 'channel-a', rtcEngine: 'windows_native', clientInstanceId: 'desktop-a',
  operationId: 'op-a', connectionEpoch: 'epoch-a', authorityVersion: 1,
  credential: { url: 'wss://voice.invalid', token: 'private-token', participantIdentity: 'participant', cameraProfiles: ['hd720p30', 'hd1080p30'] },
}

function gate() {
  let release: () => void = () => undefined
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

class Runtime {
  epoch = 1
  status: MediaRuntimeSupervisorSnapshot['status'] = 'stopped'
  readonly applied: EngineDesiredState[] = []
  readonly credentials: MediaCredentialLease[] = []
  applyGate: Promise<void> | null = null
  credentialGate: Promise<void> | null = null
  queryFailure = false
  readonly states = new Set<(snapshot: MediaRuntimeSupervisorSnapshot) => void>()
  readonly events = new Set<(event: MediaLifecycleEvent) => void>()
  readonly snapshots = new Set<(snapshot: MediaEngineSnapshot) => void>()
  current: MediaEngineSnapshot = {
    engineState: 'running', acceptedRevision: null, desiredState: null,
    roomState: 'off', tracks: createInactiveMediaPaths(),
  }
  ready: MediaLifecycleReady = {
    type: 'ready', protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION, engineState: 'running',
    build: { commit: '0'.repeat(40), napi: '8', protocolSchemaSha256: MEDIA_LIFECYCLE_SCHEMA_SHA256 },
  }
  getHostEpoch() { return this.epoch }
  getSnapshot(): MediaRuntimeSupervisorSnapshot { return { status: this.status, restartCount: this.epoch - 1 } }
  onStateChange(listener: (snapshot: MediaRuntimeSupervisorSnapshot) => void) { this.states.add(listener); return () => this.states.delete(listener) }
  onEvent(listener: (event: MediaLifecycleEvent) => void) { this.events.add(listener); return () => this.events.delete(listener) }
  onSnapshot(listener: (snapshot: MediaEngineSnapshot) => void) { this.snapshots.add(listener); return () => this.snapshots.delete(listener) }
  async start() {
    if (this.status !== 'ready') {
      this.status = 'ready'
      for (const listener of this.states) listener(this.getSnapshot())
    }
    return this.ready
  }
  async installCredentialLease(value: MediaCredentialLease) {
    this.credentials.push(value)
    if (this.credentialGate) await this.credentialGate
    return { type: 'credentialLeaseInstalled' as const, leaseId: value.leaseId }
  }
  async applyDesiredState(value: EngineDesiredState): Promise<MediaDesiredStateAccepted> {
    this.applied.push(structuredClone(value))
    const epoch = this.epoch
    if (this.applyGate) await this.applyGate
    if (epoch !== this.epoch) throw mediaLifecycleError('old_epoch', 'Old host exited', 'host', true)
    const sameRoom = value.room?.credentialLeaseId === this.current.desiredState?.room?.credentialLeaseId
    this.current = {
      engineState: 'running', acceptedRevision: value.revision, desiredState: value,
      roomState: value.room ? sameRoom ? this.current.roomState : 'connecting' : 'off',
      tracks: createInactiveMediaPaths(value.revision),
    }
    return { type: 'desiredStateAccepted', acceptedRevision: value.revision, disposition: 'accepted' }
  }
  async querySnapshot() {
    if (this.queryFailure) throw mediaLifecycleError('query_timeout', 'Snapshot deadline exceeded', 'query', true)
    return this.current
  }
  async shutdown() { this.status = 'stopped' }
  connected() {
    this.current = { ...this.current, roomState: 'connected' }
    for (const listener of this.snapshots) listener(this.current)
  }
  restart() {
    this.status = 'recovering'
    for (const listener of this.states) listener(this.getSnapshot())
    ++this.epoch
    this.current = { engineState: 'running', acceptedRevision: null, desiredState: null, roomState: 'off', tracks: createInactiveMediaPaths() }
    this.status = 'ready'
    for (const listener of this.states) listener(this.getSnapshot())
  }
}

async function join(runtime: Runtime, adapter: NativeRtcEngineAdapterV2, desired = createInitialVoiceMediaDesiredState()) {
  const connected = adapter.connect(lease, desired, new AbortController().signal)
  await vi.waitFor(() => expect(runtime.current.roomState).toBe('connecting'))
  runtime.connected()
  await connected
}

describe('NativeRtcEngineAdapterV2', () => {
  it('keeps capture warm across server mute and restores only microphone publication', async () => {
    const runtime = new Runtime()
    const adapter = new NativeRtcEngineAdapterV2(runtime)
    const desired = {
      ...createInitialVoiceMediaDesiredState(),
      cameraEnabled: true,
      screenEnabled: true,
      screenSourceId: 'screen-a',
    }
    await join(runtime, adapter, desired)
    const initial = adapter.desiredSnapshot()
    adapter.updateDesiredMedia({ ...desired, serverMuted: true, effectiveMuted: true })
    const muted = adapter.desiredSnapshot()
    expect(muted?.microphone).toMatchObject({ state: 'warm', muted: true })
    expect(muted?.room).toEqual(initial?.room)
    expect(muted?.camera).toEqual(initial?.camera)
    expect(muted?.screen).toEqual(initial?.screen)
    adapter.updateDesiredMedia({ ...desired, userMuted: true, effectiveMuted: true })
    expect(adapter.desiredSnapshot()?.microphone).toMatchObject({ state: 'on', muted: true })
    expect(runtime.credentials).toHaveLength(1)
    await adapter.dispose()
  })

  it('starts a warm microphone meter without Room credentials and stops only the meter', async () => {
    const runtime = new Runtime()
    const adapter = new NativeRtcEngineAdapterV2(runtime)
    await adapter.setMicrophonePreview(true)
    expect(adapter.desiredSnapshot()).toMatchObject({ room: null, microphone: { state: 'warm', meterDemand: true } })
    expect(runtime.credentials).toHaveLength(0)
    await adapter.setMicrophonePreview(false)
    expect(adapter.desiredSnapshot()?.microphone).toMatchObject({ state: 'warm', meterDemand: false })
    await adapter.dispose()
  })

  it('preserves product microphone bounds and disjoint volume/mute maps', async () => {
    const runtime = new Runtime()
    const adapter = new NativeRtcEngineAdapterV2(runtime)
    await join(runtime, adapter, {
      ...createInitialVoiceMediaDesiredState(), inputVolume: 4, voiceGateThresholdDb: -100,
      outputVolume: 3,
    })
    const volumes = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`volume-${index}`, 3]))
    const mutes = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`mute-${index}`, true]))
    adapter.updateRemoteAudioSettings({
      revision: 1, userVolumes: volumes, userMutes: mutes, streamVolumes: volumes, streamMutes: mutes,
    })
    const snapshot = adapter.desiredSnapshot()
    expect(snapshot?.microphone).toMatchObject({ inputVolume: 4, gateThresholdDb: -100 })
    expect(snapshot?.output).toMatchObject({ state: 'on', volume: 3 })
    if (snapshot?.output.state !== 'on') throw new Error('Output intent missing')
    expect(snapshot.output.users).toHaveLength(1024)
    expect(snapshot.output.streams).toHaveLength(1024)
    expect(snapshot.output.users).toContainEqual({ identity: 'mute-0', volume: 1, muted: true })
    expect(snapshot.output.users).toContainEqual({ identity: 'volume-0', volume: 3, muted: false })
    await adapter.dispose()
  })

  it('waits for the exact Room lease without waiting for microphone readiness', async () => {
    const runtime = new Runtime()
    const adapter = new NativeRtcEngineAdapterV2(runtime)
    const done = vi.fn()
    const connected = adapter.connect(lease, createInitialVoiceMediaDesiredState(), new AbortController().signal).then(done)
    await vi.waitFor(() => expect(runtime.applied).toHaveLength(1))
    expect(done).not.toHaveBeenCalled()
    expect(JSON.stringify(runtime.applied)).not.toContain('private-token')
    expect(runtime.credentials[0]?.accessToken).toBe('private-token')
    runtime.connected()
    await connected
    expect(adapter.snapshot().tracks.microphone.state).toBe('off')
    await adapter.dispose()
  })

  it('rejects a camera profile before publication without losing the Room or silently lowering quality', async () => {
    const runtime = new Runtime()
    const adapter = new NativeRtcEngineAdapterV2(runtime)
    const events: VoiceEngineEvent[] = []
    adapter.subscribe(event => events.push(event))
    const limitedLease: VoiceLease = {
      ...lease, credential: { ...lease.credential, cameraProfiles: ['hd720p30'] },
    }
    const desired: VoiceMediaDesiredState = {
      ...createInitialVoiceMediaDesiredState(),
      cameraEnabled: true, cameraProfile: 'hd1080p30',
    }
    const connecting = adapter.connect(limitedLease, desired, new AbortController().signal)
    await vi.waitFor(() => expect(runtime.current.roomState).toBe('connecting'))
    runtime.connected()
    await connecting
    expect(adapter.desiredSnapshot()?.camera).toEqual({ state: 'off' })
    expect(adapter.snapshot().tracks.camera).toMatchObject({
      state: 'failed', failure: { code: 'camera_profile_not_permitted', retryable: false },
    })
    adapter.retryMedia('camera')
    await vi.waitFor(() => expect(runtime.applied).toHaveLength(2))
    expect(runtime.applied.every(value => value.camera.state === 'off')).toBe(true)

    adapter.updateDesiredMedia({ ...desired, cameraProfile: 'hd720p30' })
    await vi.waitFor(() => expect(runtime.applied.at(-1)?.camera).toMatchObject({
      state: 'on', profile: 'hd720p30',
    }))
    await vi.waitFor(() => expect(adapter.snapshot().tracks.camera.failure).toBeUndefined())
    expect(runtime.credentials).toHaveLength(1)
    expect(adapter.snapshot().roomState).toBe('connected')
    expect(events.some(event => event.type === 'terminalFailure')).toBe(false)
    await adapter.dispose()
  })

  it('coalesces pending intent and preserves camera/screen during mute and PTT', async () => {
    const runtime = new Runtime()
    const adapter = new NativeRtcEngineAdapterV2(runtime)
    const desired = {
      ...createInitialVoiceMediaDesiredState(), cameraEnabled: true,
      screenEnabled: true, screenSourceId: 'source-1', screenWidth: 1920,
      screenHeight: 1080, screenFps: 60, screenAudioEnabled: true,
    }
    await join(runtime, adapter, desired)
    const hold = gate()
    runtime.applyGate = hold.promise
    adapter.updateDesiredMedia({ ...desired, effectiveMuted: true })
    await vi.waitFor(() => expect(runtime.applied).toHaveLength(2))
    for (let index = 0; index < 100; ++index) {
      adapter.updateDesiredMedia({ ...desired, effectiveMuted: true, pushToTalkHeld: index === 99 })
    }
    hold.release()
    await vi.waitFor(() => expect(runtime.applied).toHaveLength(3))
    expect(runtime.applied[2]).toMatchObject({
      microphone: { state: 'on', muted: true, pushToTalkHeld: true },
      camera: { state: 'on', publication: true },
      screen: { state: 'on', width: 1920, height: 1080, fps: 60, audioMode: 'system' },
    })
    expect(runtime.credentials).toHaveLength(1)
    await adapter.dispose()
  })

  it('replays only the latest snapshot after a host loss while an old request is pending', async () => {
    const runtime = new Runtime()
    const adapter = new NativeRtcEngineAdapterV2(runtime)
    await join(runtime, adapter)
    const hold = gate()
    runtime.applyGate = hold.promise
    adapter.updateDesiredMedia({ ...createInitialVoiceMediaDesiredState(), effectiveMuted: true })
    await vi.waitFor(() => expect(runtime.applied).toHaveLength(2))
    adapter.updateDesiredMedia({ ...createInitialVoiceMediaDesiredState(), effectiveMuted: false, cameraEnabled: true })
    runtime.restart()
    runtime.applyGate = null
    hold.release()
    await vi.waitFor(() => expect(runtime.applied).toHaveLength(3))
    expect(runtime.credentials).toHaveLength(2)
    expect(runtime.applied[2]).toEqual(adapter.desiredSnapshot())
    expect(runtime.applied[2]).toMatchObject({ microphone: { muted: false }, camera: { state: 'on' } })
    await adapter.dispose()
  })

  it('invalidates old host media before publishing recovery and new host availability', async () => {
    const runtime = new Runtime()
    const adapter = new NativeRtcEngineAdapterV2(runtime)
    const desired = createInitialVoiceMediaDesiredState()
    await join(runtime, adapter, desired)
    runtime.current = {
      ...runtime.current,
      tracks: { ...runtime.current.tracks, microphone: {
        revision: runtime.current.acceptedRevision ?? 0, state: 'running', warning: false,
      } },
    }
    runtime.connected()
    expect(adapter.snapshot().tracks.microphone.state).toBe('running')
    adapter.updateDesiredMedia({ ...desired, userMuted: true, effectiveMuted: true })
    const latest = adapter.desiredSnapshot()
    const availabilitySnapshots: MediaEngineSnapshot[] = []
    const snapshots: MediaEngineSnapshot[] = []
    adapter.onSnapshot(snapshot => snapshots.push(snapshot))
    const unsubscribe = adapter.subscribe(event => {
      if (event.type === 'availabilityChanged') availabilitySnapshots.push(adapter.snapshot())
    })
    availabilitySnapshots.length = 0
    runtime.restart()
    expect(availabilitySnapshots).toHaveLength(2)
    for (const snapshot of availabilitySnapshots) {
      expect(snapshot).toEqual({
        engineState: 'stopped', acceptedRevision: null, desiredState: null,
        roomState: 'off', tracks: createInactiveMediaPaths(),
      })
    }
    expect(snapshots.at(-1)).toEqual(adapter.snapshot())
    expect(adapter.desiredSnapshot()).toEqual(latest)
    await vi.waitFor(() => expect(runtime.applied.at(-1)).toEqual(latest))
    expect(runtime.applied.at(-1)?.microphone).toMatchObject({ muted: true })
    unsubscribe()
    await adapter.dispose()
  })

  it('cancels a superseded credential completion without applying its old Room', async () => {
    const runtime = new Runtime()
    const adapter = new NativeRtcEngineAdapterV2(runtime)
    const hold = gate()
    runtime.credentialGate = hold.promise
    const abort = new AbortController()
    const oldConnect = adapter.connect(lease, createInitialVoiceMediaDesiredState(), abort.signal)
    const rejected = expect(oldConnect).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(runtime.credentials).toHaveLength(1))
    abort.abort()
    const nextConnect = adapter.connect({ ...lease, channelId: 'channel-b', operationId: 'op-b', connectionEpoch: 'epoch-b' }, createInitialVoiceMediaDesiredState(), new AbortController().signal)
    runtime.credentialGate = null
    hold.release()
    await rejected
    await vi.waitFor(() => expect(runtime.applied).toHaveLength(1))
    expect(runtime.applied[0]?.room?.roomId).toBe('channel-b')
    runtime.connected()
    await nextConnect
    await adapter.dispose()
  })

  it('revokes only renderer demand during reload and ignores old renderer requests', async () => {
    const runtime = new Runtime()
    const adapter = new NativeRtcEngineAdapterV2(runtime)
    await join(runtime, adapter, { ...createInitialVoiceMediaDesiredState(), cameraEnabled: true, screenEnabled: true, screenSourceId: 'source-1' })
    adapter.rendererReady('renderer-1')
    adapter.setPreviewDemand('renderer-1', true, true)
    const room = adapter.desiredSnapshot()?.room
    adapter.rendererGone('renderer-1')
    adapter.rendererReady('renderer-2')
    adapter.setPreviewDemand('renderer-1', true, true)
    expect(adapter.desiredSnapshot()).toMatchObject({
      room,
      camera: { state: 'on', publication: true, previewRendererId: null },
      screen: { state: 'on', previewRendererId: null },
    })
    expect(runtime.credentials).toHaveLength(1)
    await adapter.dispose()
  })

  it('does not turn path failure or a snapshot timeout into Room recovery', async () => {
    const runtime = new Runtime()
    const failures = vi.fn()
    const adapter = new NativeRtcEngineAdapterV2(runtime, () => 'lease-1', failures)
    const events: VoiceEngineEvent[] = []
    adapter.subscribe(event => events.push(event))
    await join(runtime, adapter)
    for (const listener of runtime.events) listener({
      type: 'trackStateChanged', sequence: 10, revision: runtime.current.acceptedRevision ?? 0,
      track: 'camera', state: 'failed', warning: false,
      failure: { code: 'camera_unavailable', message: 'Camera unavailable', stage: 'camera', retryable: true },
    })
    expect(events.some(event => event.type === 'mediaState' && event.kind === 'camera' && event.media.state === 'failed')).toBe(true)
    runtime.queryFailure = true
    adapter.retryMedia('camera')
    await vi.waitFor(() => expect(failures).toHaveBeenCalled())
    expect(events.some(event => event.type === 'terminalFailure')).toBe(false)
    await adapter.dispose()
  })
})
