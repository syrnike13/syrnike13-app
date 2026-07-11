import { describe, expect, it, vi } from 'vitest'

import type {
  VoiceAuthorityAdapter,
  VoiceAuthorityEvent,
  VoiceCancellation,
  VoiceReservationRequest,
  VoiceSelfStateUpdate,
} from './voice-authority'
import { VoiceDirector } from './voice-director'
import type {
  RtcEngineAdapter,
  VoiceDisconnectCause,
  VoiceEngineEvent,
} from './voice-engine'
import type {
  AuthoritativeVoiceSnapshot,
  VoiceLease,
  VoiceMediaDesiredState,
  VoiceMediaKind,
  VoiceRemoteAudioSettings,
} from './voice-types'

class FakeAuthority implements VoiceAuthorityAdapter {
  readonly reservations: VoiceReservationRequest[] = []
  readonly cancellations: VoiceCancellation[] = []
  readonly selfStateUpdates: VoiceSelfStateUpdate[] = []
  private readonly listeners = new Set<(event: VoiceAuthorityEvent) => void>()
  private authorityVersion = 0

  async reserve(input: VoiceReservationRequest, signal: AbortSignal) {
    if (signal.aborted) throw abortError()
    this.reservations.push(input)
    return {
      ...input,
      authorityVersion: this.authorityVersion,
      credential: {
        url: 'wss://voice.invalid',
        token: `token-${input.operationId}`,
        participantIdentity: `identity-${input.connectionEpoch}`,
      },
    } satisfies VoiceLease
  }

  async cancel(input: VoiceCancellation) {
    this.cancellations.push(input)
  }

  async updateSelfState(input: VoiceSelfStateUpdate) {
    this.selfStateUpdates.push(input)
  }

  subscribe(listener: (event: VoiceAuthorityEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async requestSnapshot() {}

  commit(lease: VoiceLease, flags?: { muted?: boolean; deafened?: boolean }) {
    this.emitSnapshot({
      channelId: lease.channelId,
      rtcEngine: lease.rtcEngine,
      clientInstanceId: lease.clientInstanceId,
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
    }, flags)
  }

  emitSnapshot(
    membership: AuthoritativeVoiceSnapshot['membership'],
    flags?: { muted?: boolean; deafened?: boolean },
  ) {
    this.authorityVersion += 1
    const snapshot: AuthoritativeVoiceSnapshot = {
      authorityVersion: this.authorityVersion,
      complete: true,
      membership,
      serverMuted: flags?.muted ?? false,
      serverDeafened: flags?.deafened ?? false,
    }
    for (const listener of this.listeners) {
      listener({ type: 'snapshot', snapshot })
    }
  }

  controlUnavailable() {
    for (const listener of this.listeners) {
      listener({ type: 'controlUnavailable' })
    }
  }

  forceMove(from: VoiceLease, lease: VoiceLease) {
    for (const listener of this.listeners) {
      listener({
        type: 'forcedMove',
        from: {
          channelId: from.channelId,
          rtcEngine: from.rtcEngine,
          clientInstanceId: from.clientInstanceId,
          operationId: from.operationId,
          connectionEpoch: from.connectionEpoch,
        },
        lease,
      })
    }
  }
}

class FakeEngine implements RtcEngineAdapter {
  readonly connected: VoiceLease[] = []
  readonly disconnected: VoiceDisconnectCause[] = []
  readonly desired: VoiceMediaDesiredState[] = []
  readonly retriedMedia: VoiceMediaKind[] = []
  private readonly listeners = new Set<(event: VoiceEngineEvent) => void>()
  private readonly blockedChannels = new Set<string>()
  private readonly failedChannels = new Map<string, Error>()

  block(channelId: string) {
    this.blockedChannels.add(channelId)
  }

  unblock(channelId: string) {
    this.blockedChannels.delete(channelId)
  }

  fail(channelId: string, message = `failed ${channelId}`) {
    this.failedChannels.set(channelId, new Error(message))
  }

  recover(channelId: string) {
    this.failedChannels.delete(channelId)
  }

  async connect(
    lease: VoiceLease,
    desired: VoiceMediaDesiredState,
    signal: AbortSignal,
  ) {
    this.connected.push(lease)
    this.desired.push(desired)
    const failure = this.failedChannels.get(lease.channelId)
    if (failure) throw failure
    while (this.blockedChannels.has(lease.channelId)) {
      await new Promise<void>((resolve, reject) => {
        const poll = setTimeout(resolve, 1)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(poll)
            reject(abortError())
          },
          { once: true },
        )
      })
    }
    if (signal.aborted) throw abortError()
  }

  async disconnect(cause: VoiceDisconnectCause) {
    this.disconnected.push(cause)
  }

  updateDesiredMedia(desired: VoiceMediaDesiredState) {
    this.desired.push(desired)
  }

  updateRemoteAudioSettings(_settings: VoiceRemoteAudioSettings) {}

  retryMedia(kind: VoiceMediaKind) {
    this.retriedMedia.push(kind)
  }

  subscribe(listener: (event: VoiceEngineEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: VoiceEngineEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

function createHarness(options?: { recoveryDelaysMs?: readonly number[] }) {
  const authority = new FakeAuthority()
  const engine = new FakeEngine()
  let operation = 0
  let epoch = 0
  const director = new VoiceDirector({
    authority,
    engine,
    rtcEngine: 'windows_native',
    clientInstanceId: 'desktop-instance',
    createOperationId: () => `op-${++operation}`,
    createConnectionEpoch: () => `epoch-${++epoch}`,
    commitTimeoutMs: 2_000,
    recoveryDelaysMs: options?.recoveryDelaysMs ?? [0, 0, 0],
    delay: async () => {},
  })
  return { authority, director, engine }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not reached')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

async function connect(
  harness: ReturnType<typeof createHarness>,
  channelId: string,
) {
  harness.director.dispatch({ type: 'join', channelId })
  await waitUntil(() =>
    harness.engine.connected.some((lease) => lease.channelId === channelId),
  )
  const lease = [...harness.engine.connected].reverse().find(
    (candidate) => candidate.channelId === channelId,
  )!
  harness.authority.commit(lease)
  await harness.director.waitForIdle()
  return lease
}

describe('VoiceDirector', () => {
  it('does not report connected until exact RTC presence commits membership', async () => {
    const harness = createHarness()
    harness.director.dispatch({ type: 'join', channelId: 'A' })

    await waitUntil(() => harness.engine.connected.length === 1)
    expect(harness.director.snapshot().connection).toBe('connecting')
    expect(harness.director.snapshot().membershipChannelId).toBeNull()

    const lease = harness.engine.connected[0]
    harness.authority.emitSnapshot({
      ...lease,
      channelId: 'other',
    })
    expect(harness.director.snapshot().connection).toBe('connecting')

    harness.authority.commit(lease)
    await harness.director.waitForIdle()
    expect(harness.director.snapshot()).toMatchObject({
      connection: 'connected',
      intentChannelId: 'A',
      membershipChannelId: 'A',
      operationId: 'op-1',
      connectionEpoch: 'epoch-1',
    })
  })

  it('performs break-before-make and leaves failed destination disconnected', async () => {
    const harness = createHarness()
    await connect(harness, 'A')
    harness.engine.fail('B')

    harness.director.dispatch({ type: 'join', channelId: 'B' })
    await harness.director.waitForIdle()

    expect(harness.engine.disconnected).toContain('move')
    expect(harness.director.snapshot()).toMatchObject({
      connection: 'failed',
      intentChannelId: 'B',
      membershipChannelId: null,
    })
    expect(harness.engine.connected.map((lease) => lease.channelId)).toEqual([
      'A',
      'B',
    ])
  })

  it('makes the latest A to B to A intent win over a blocked B connect', async () => {
    const harness = createHarness()
    await connect(harness, 'A')
    harness.engine.block('B')

    harness.director.dispatch({ type: 'join', channelId: 'B' })
    await waitUntil(() =>
      harness.engine.connected.some((lease) => lease.channelId === 'B'),
    )
    harness.director.dispatch({ type: 'join', channelId: 'A' })

    await waitUntil(
      () =>
        harness.engine.connected.filter((lease) => lease.channelId === 'A')
          .length === 2,
    )
    const finalLease = [...harness.engine.connected].reverse().find(
      (lease) => lease.channelId === 'A',
    )!
    harness.authority.commit(finalLease)
    await harness.director.waitForIdle()

    expect(harness.director.snapshot()).toMatchObject({
      connection: 'connected',
      intentChannelId: 'A',
      membershipChannelId: 'A',
      operationId: finalLease.operationId,
      connectionEpoch: finalLease.connectionEpoch,
    })
    expect(finalLease.operationId).not.toBe('op-1')
    expect(
      harness.authority.cancellations.some(
        (item) => item.operationId === 'op-2' && item.reason === 'superseded',
      ),
    ).toBe(true)
  })

  it('uses the supplied authoritative lease for an exact forced move', async () => {
    const harness = createHarness()
    const original = await connect(harness, 'A')
    const forcedLease: VoiceLease = {
      channelId: 'B',
      rtcEngine: original.rtcEngine,
      clientInstanceId: original.clientInstanceId,
      operationId: 'admin-op-b',
      connectionEpoch: 'admin-epoch-b',
      authorityVersion: original.authorityVersion + 2,
      credential: {
        url: 'wss://voice.invalid',
        token: 'admin-token-b',
        participantIdentity: 'admin-identity-b',
      },
    }

    harness.authority.forceMove(original, forcedLease)
    await waitUntil(() => harness.engine.connected.includes(forcedLease))

    expect(harness.authority.reservations).toHaveLength(1)
    expect(harness.engine.disconnected).toContain('move')
    expect(harness.director.snapshot()).toMatchObject({
      connection: 'connecting',
      intentChannelId: 'B',
      membershipChannelId: null,
      operationId: 'admin-op-b',
      connectionEpoch: 'admin-epoch-b',
    })

    harness.authority.commit(forcedLease)
    await harness.director.waitForIdle()
    expect(harness.director.snapshot()).toMatchObject({
      connection: 'connected',
      membershipChannelId: 'B',
      operationId: 'admin-op-b',
    })
  })

  it('cancels a stale or mismatched forced move without touching current RTC', async () => {
    const harness = createHarness()
    const original = await connect(harness, 'A')
    const mismatchedFrom = { ...original, connectionEpoch: 'stale-epoch' }
    const forcedLease: VoiceLease = {
      ...original,
      channelId: 'B',
      operationId: 'stale-admin-op',
      connectionEpoch: 'stale-admin-epoch',
      authorityVersion: original.authorityVersion + 2,
      credential: {
        url: 'wss://voice.invalid',
        token: 'stale-token',
        participantIdentity: 'stale-identity',
      },
    }

    harness.authority.forceMove(mismatchedFrom, forcedLease)
    await waitUntil(() =>
      harness.authority.cancellations.some(
        (cancellation) => cancellation.operationId === forcedLease.operationId,
      ),
    )

    expect(harness.director.snapshot()).toMatchObject({
      connection: 'connected',
      intentChannelId: 'A',
      membershipChannelId: 'A',
    })
    expect(harness.engine.connected).toHaveLength(1)
    expect(harness.engine.disconnected).toHaveLength(0)
  })

  it('leaves a failed forced destination disconnected until manual retry', async () => {
    const harness = createHarness()
    const original = await connect(harness, 'A')
    harness.engine.fail('B', 'admin destination failed')
    const forcedLease: VoiceLease = {
      ...original,
      channelId: 'B',
      operationId: 'admin-op-b',
      connectionEpoch: 'admin-epoch-b',
      authorityVersion: original.authorityVersion + 2,
      credential: {
        url: 'wss://voice.invalid',
        token: 'admin-token-b',
        participantIdentity: 'admin-identity-b',
      },
    }

    harness.authority.forceMove(original, forcedLease)
    await harness.director.waitForIdle()

    expect(harness.director.snapshot()).toMatchObject({
      connection: 'failed',
      intentChannelId: 'B',
      membershipChannelId: null,
    })
    expect(harness.authority.cancellations).toContainEqual({
      rtcEngine: forcedLease.rtcEngine,
      clientInstanceId: forcedLease.clientInstanceId,
      operationId: forcedLease.operationId,
      connectionEpoch: forcedLease.connectionEpoch,
      reason: 'connect_failed',
    })

    harness.engine.recover('B')
    harness.director.dispatch({ type: 'retryVoice' })
    await waitUntil(() => harness.authority.reservations.length === 2)
    const retry = harness.authority.reservations.at(-1)!
    expect(retry.operationId).not.toBe(forcedLease.operationId)
    expect(retry.connectionEpoch).not.toBe(forcedLease.connectionEpoch)
    harness.director.dispatch({ type: 'leave' })
    await harness.director.waitForIdle()
  })

  it('accepts mute changes while connect is blocked without waiting for RTC', async () => {
    const harness = createHarness()
    harness.engine.block('A')
    harness.director.dispatch({ type: 'join', channelId: 'A' })
    await waitUntil(() => harness.engine.connected.length === 1)

    harness.director.dispatch({ type: 'setUserMuted', muted: false })

    expect(harness.director.snapshot()).toMatchObject({
      connection: 'connecting',
      userMuted: false,
      effectiveMuted: false,
    })
    expect(harness.engine.desired.at(-1)?.effectiveMuted).toBe(false)

    harness.director.dispatch({ type: 'leave' })
    await harness.director.waitForIdle()
  })

  it('keeps user mute independent from deafen and administrative flags', async () => {
    const harness = createHarness()
    harness.director.dispatch({ type: 'setUserMuted', muted: false })
    harness.director.dispatch({ type: 'setUserDeafened', deafened: true })
    expect(harness.director.snapshot()).toMatchObject({
      userMuted: false,
      userDeafened: true,
      effectiveMuted: true,
    })

    harness.director.dispatch({ type: 'setUserDeafened', deafened: false })
    expect(harness.director.snapshot().effectiveMuted).toBe(false)

    harness.authority.emitSnapshot(null, { muted: true })
    expect(harness.director.snapshot()).toMatchObject({
      userMuted: false,
      serverMuted: true,
      effectiveMuted: true,
    })
    harness.authority.emitSnapshot(null, { muted: false })
    expect(harness.director.snapshot()).toMatchObject({
      userMuted: false,
      effectiveMuted: false,
    })
  })

  it('updates authoritative user flags without reconnecting RTC', async () => {
    const harness = createHarness()
    const lease = await connect(harness, 'A')
    const connectsBefore = harness.engine.connected.length

    harness.director.dispatch({ type: 'setUserMuted', muted: false })
    harness.director.dispatch({ type: 'setUserDeafened', deafened: true })
    await waitUntil(() =>
      harness.authority.selfStateUpdates.some(
        (update) =>
          update.operationId === lease.operationId &&
          !update.userMuted &&
          update.userDeafened,
      ),
    )

    expect(harness.engine.connected).toHaveLength(connectsBefore)
  })

  it('projects speaking participants without changing connection ownership', async () => {
    const harness = createHarness()
    const lease = await connect(harness, 'A')
    harness.engine.emit({
      type: 'speakingChanged',
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
      participantIdentities: ['voice-remote-a', 'voice-remote-a'],
    })
    expect(harness.director.snapshot().speakingUserIds).toEqual([
      'voice-remote-a',
    ])
    expect(harness.engine.connected).toHaveLength(1)

    harness.director.dispatch({ type: 'leave' })
    await harness.director.waitForIdle()
    expect(harness.director.snapshot().speakingUserIds).toEqual([])
  })

  it('does not tear down RTC merely because control transport is unavailable', async () => {
    const harness = createHarness()
    await connect(harness, 'A')

    harness.authority.controlUnavailable()
    await Promise.resolve()

    expect(harness.director.snapshot().connection).toBe('connected')
    expect(harness.engine.disconnected).toHaveLength(0)
  })

  it('recovers a terminal RTC failure with a new operation and epoch', async () => {
    const harness = createHarness({ recoveryDelaysMs: [0, 0, 0] })
    const original = await connect(harness, 'A')

    harness.engine.emit({
      type: 'terminalFailure',
      operationId: original.operationId,
      connectionEpoch: original.connectionEpoch,
      failure: {
        code: 'runtime_lost',
        message: 'Media runtime exited',
        retryable: true,
      },
    })

    await waitUntil(() => harness.engine.connected.length === 2)
    const recovered = harness.engine.connected[1]
    expect(recovered.operationId).not.toBe(original.operationId)
    expect(recovered.connectionEpoch).not.toBe(original.connectionEpoch)
    expect(harness.engine.disconnected).toContain('recovery')
    expect(harness.authority.cancellations).toContainEqual({
      rtcEngine: original.rtcEngine,
      clientInstanceId: original.clientInstanceId,
      operationId: original.operationId,
      connectionEpoch: original.connectionEpoch,
      reason: 'superseded',
    })
    harness.authority.commit(recovered)
    await harness.director.waitForIdle()

    expect(harness.director.snapshot()).toMatchObject({
      connection: 'connected',
      membershipChannelId: 'A',
      operationId: recovered.operationId,
      connectionEpoch: recovered.connectionEpoch,
    })
  })

  it('does not reconnect Room when one media track fails', async () => {
    const harness = createHarness()
    const lease = await connect(harness, 'A')
    const connectsBefore = harness.engine.connected.length

    harness.engine.emit({
      type: 'mediaState',
      kind: 'microphone',
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
      media: {
        state: 'failed',
        error: {
          code: 'microphone_unavailable',
          message: 'Microphone unavailable',
          retryable: true,
        },
      },
    })

    expect(harness.director.snapshot()).toMatchObject({
      connection: 'connected',
      membershipChannelId: 'A',
      microphone: { state: 'failed' },
    })
    expect(harness.engine.connected).toHaveLength(connectsBefore)
  })

  it('clears intent on sleep and never restores it automatically', async () => {
    const harness = createHarness()
    const lease = await connect(harness, 'A')

    await harness.director.shutdown('sleep')

    expect(harness.director.snapshot()).toMatchObject({
      connection: 'disconnected',
      intentChannelId: null,
      membershipChannelId: null,
    })
    expect(harness.authority.cancellations).toContainEqual({
      rtcEngine: lease.rtcEngine,
      clientInstanceId: lease.clientInstanceId,
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
      reason: 'leave',
    })
  })

  it('forces privacy mute while locked without changing the user button', () => {
    const harness = createHarness()
    harness.director.dispatch({ type: 'setUserMuted', muted: false })
    harness.director.dispatch({ type: 'setSystemPrivacyMuted', muted: true })
    expect(harness.director.snapshot()).toMatchObject({
      userMuted: false,
      systemPrivacyMuted: true,
      effectiveMuted: true,
    })
    harness.director.dispatch({ type: 'setSystemPrivacyMuted', muted: false })
    expect(harness.director.snapshot()).toMatchObject({
      userMuted: false,
      effectiveMuted: false,
    })
  })
})

function abortError() {
  return new DOMException('aborted', 'AbortError')
}
