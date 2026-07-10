import { describe, expect, it, vi } from 'vitest'
import type {
  LocalMediaIntent,
  LocalMediaObservedStateEvent,
} from '@syrnike13/platform'

import {
  createVoiceNativeMediaOwner,
} from '#/features/voice/voice-native-media-owner'

function lease(operationId: string, channelId: string) {
  return {
    operationId,
    channelId,
    credentials: {
      microphone: {
        url: 'wss://example.test',
        token: `mic-${operationId}`,
        participantIdentity: `user-1:desktop-native:${operationId}:microphone`,
      },
      screen: {
        url: 'wss://example.test',
        token: `screen-${operationId}`,
        participantIdentity: `user-1:desktop-native:${operationId}:screen`,
      },
      camera: {
        url: 'wss://example.test',
        token: `camera-${operationId}`,
        participantIdentity: `user-1:desktop-native:${operationId}:camera`,
      },
    },
  } as const
}

function createDesktop() {
  const intents: LocalMediaIntent[] = []
  let listener: ((event: LocalMediaObservedStateEvent) => void) | null = null
  const desktop = {
    platform: { os: 'win32' as const },
    media: {
      applyLocalMediaIntent: vi.fn(async (intent: LocalMediaIntent) => {
        intents.push(intent)
        return {
          operationId: intent.operationId,
          acceptedEnvelopeRevision: intent.envelopeRevision,
          disposition: 'accepted' as const,
        }
      }),
      onLocalMediaState: vi.fn((nextListener: (event: LocalMediaObservedStateEvent) => void) => {
        listener = nextListener
        return () => {
          listener = null
        }
      }),
    },
  }

  return {
    desktop,
    intents,
    emit(event: LocalMediaObservedStateEvent) {
      listener?.(event)
    },
  }
}

describe('createVoiceNativeMediaOwner', () => {
  it('keeps microphone in retain until the replacement lease arrives', async () => {
    const runtime = createDesktop()
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => runtime.desktop as never)

    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))
    await owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })

    owner.setVoiceContext({ operationId: 'op-b', channelId: 'voice-b' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))
    owner.setLiveKitCredentials(lease('op-b', 'voice-b'))

    const microphoneStates = runtime.intents.map((intent) => intent.microphone.state)
    expect(microphoneStates).toContain('publish')
    expect(microphoneStates).toContain('retain')
    expect(runtime.intents.at(-2)?.microphone).toMatchObject({
      state: 'retain',
    })
    expect(runtime.intents.at(-1)?.microphone).toMatchObject({
      state: 'publish',
      credentials: lease('op-b', 'voice-b').credentials.microphone,
    })
    expect(runtime.intents.at(-3)?.microphone.revision).toBe(1)
    expect(runtime.intents.at(-2)?.microphone.revision).toBe(2)
    expect(runtime.intents.at(-1)?.microphone.revision).toBe(3)
  })

  it('ignores stale observed events after returning from B to A', async () => {
    const runtime = createDesktop()
    const owner = createVoiceNativeMediaOwner()
    const observed = vi.fn()
    owner.bindDesktop(() => runtime.desktop as never, {
      onMicrophoneState: observed,
    })

    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))
    await owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })
    runtime.emit({
      kind: 'microphone',
      operationId: 'op-a',
      revision: 1,
      reconcileAttempt: 1,
      sequence: 1,
      state: 'published',
      muted: false,
      audioBitrateKbps: 96,
      participantIdentity: 'user-1:desktop-native:op-a:microphone',
    })

    owner.setVoiceContext({ operationId: 'op-b', channelId: 'voice-b' })
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))

    runtime.emit({
      kind: 'microphone',
      operationId: 'op-b',
      revision: 2,
      reconcileAttempt: 2,
      sequence: 1,
      state: 'retained',
      muted: false,
      audioBitrateKbps: 96,
      participantIdentity: 'user-1:desktop-native:op-b:microphone',
    })

    expect(observed).toHaveBeenCalledTimes(1)
  })

  it('does not report retained A as a published microphone for B', async () => {
    const runtime = createDesktop()
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => runtime.desktop as never)

    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))
    const revisionA = await owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })
    expect(revisionA).not.toBeNull()
    runtime.emit({
      kind: 'microphone',
      operationId: 'op-a',
      revision: revisionA!,
      reconcileAttempt: 1,
      sequence: 1,
      state: 'published',
      muted: false,
      audioBitrateKbps: 96,
      participantIdentity: 'user-1:desktop-native:op-a:microphone',
    })
    expect(owner.hasActiveMicrophone('voice-a')).toBe(true)

    owner.setVoiceContext({ operationId: 'op-b', channelId: 'voice-b' })
    const retained = runtime.intents.at(-1)
    expect(retained?.microphone.state).toBe('retain')
    runtime.emit({
      kind: 'microphone',
      operationId: 'op-b',
      revision: retained!.microphone.revision,
      reconcileAttempt: 2,
      sequence: 2,
      state: 'retained',
      muted: false,
      audioBitrateKbps: 96,
      participantIdentity: 'user-1:desktop-native:op-a:microphone',
    })

    expect(owner.hasActiveMicrophone('voice-b')).toBe(false)
    expect(owner.hasMicrophonePublishing('voice-b')).toBe(false)
    expect(owner.hasObservedMicrophone()).toBe(false)
  })

  it('waits for exact published operation and revision before reporting readiness', async () => {
    const runtime = createDesktop()
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => runtime.desktop as never)
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))
    const revision = await owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })
    expect(revision).not.toBeNull()

    let resolved = false
    const published = owner.waitForMicrophonePublished(revision!, 1_000)
    void published.then(() => {
      resolved = true
    })
    runtime.emit({
      kind: 'microphone',
      operationId: 'op-a',
      revision: revision!,
      reconcileAttempt: 1,
      sequence: 1,
      state: 'retained',
      muted: false,
      audioBitrateKbps: 96,
      participantIdentity: 'user-1:desktop-native:op-a:microphone',
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    runtime.emit({
      kind: 'microphone',
      operationId: 'op-a',
      revision: revision!,
      reconcileAttempt: 2,
      sequence: 2,
      state: 'published',
      muted: false,
      audioBitrateKbps: 96,
      participantIdentity: 'user-1:desktop-native:op-a:microphone',
    })
    await expect(published).resolves.toMatchObject({
      operationId: 'op-a',
      revision,
      state: 'published',
    })
  })

  it('shares the rejection of an identical pending intent application', async () => {
    const intents: LocalMediaIntent[] = []
    let rejectPublish!: (error: Error) => void
    const publishApplication = new Promise<never>((_resolve, reject) => {
      rejectPublish = reject
    })
    const desktop = {
      platform: { os: 'win32' as const },
      media: {
        applyLocalMediaIntent: vi.fn(async (intent: LocalMediaIntent) => {
          intents.push(intent)
          if (intent.microphone.state === 'publish') {
            return publishApplication
          }
          return {
            operationId: intent.operationId,
            acceptedEnvelopeRevision: intent.envelopeRevision,
            disposition: 'accepted' as const,
          }
        }),
        onLocalMediaState: vi.fn(() => () => {}),
      },
    }
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => desktop as never)
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))
    await Promise.resolve()
    await Promise.resolve()

    const first = owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })
    await Promise.resolve()
    const second = owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })
    rejectPublish(new Error('runtime_lost'))

    await expect(first).rejects.toThrow('runtime_lost')
    await expect(second).rejects.toThrow('runtime_lost')
    expect(
      intents.filter((intent) => intent.microphone.state === 'publish'),
    ).toHaveLength(1)
  })

  it('accepts mute updates while publish acceptance is still pending', async () => {
    const intents: LocalMediaIntent[] = []
    let resolveFirst!: () => void
    const firstApplied = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const desktop = {
      platform: { os: 'win32' as const },
      media: {
        applyLocalMediaIntent: vi
          .fn()
          .mockImplementationOnce(async (intent: LocalMediaIntent) => {
            intents.push(intent)
            await firstApplied
            return {
              operationId: intent.operationId,
              acceptedEnvelopeRevision: intent.envelopeRevision,
              disposition: 'accepted' as const,
            }
          })
          .mockImplementation(async (intent: LocalMediaIntent) => {
            intents.push(intent)
            return {
              operationId: intent.operationId,
              acceptedEnvelopeRevision: intent.envelopeRevision,
              disposition: 'accepted' as const,
            }
          }),
        onLocalMediaState: vi.fn(() => () => {}),
      },
    }
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => desktop as never)
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))

    const publish = owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })
    const mute = owner.setDesiredMicrophoneMuted(true)
    resolveFirst()
    await Promise.all([publish, mute])

    expect(intents.at(-2)?.microphone).toMatchObject({
      state: 'publish',
      muted: false,
    })
    expect(intents.at(-1)?.microphone).toMatchObject({
      state: 'publish',
      muted: true,
    })
  })

  it('drives screen share through prepare, publish, and off intents', async () => {
    const runtime = createDesktop()
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => runtime.desktop as never)
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))

    const source = {
      sourceId: 'screen:1',
      width: 1920,
      height: 1080,
      fps: 30,
      bitrate: 8_000_000,
      audioBitrate: 96_000,
      audioRequested: true,
    } as const

    await owner.prepareScreenShare(source)
    await owner.publishScreenShare(source)
    await owner.stopScreenShare()

    expect(runtime.intents.map((intent) => intent.screen.state)).toEqual([
      'off',
      'off',
      'prepare',
      'publish',
      'off',
    ])
  })

  it('keeps desired screen intent intact when a runtime error is observed', async () => {
    const runtime = createDesktop()
    const observed = vi.fn()
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => runtime.desktop as never, {
      onScreenState: observed,
    })
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))

    const source = {
      sourceId: 'screen:1',
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 4_000_000,
      audioBitrate: 96_000,
      audioRequested: false,
    } as const

    await owner.publishScreenShare(source)
    const applyCountBeforeError = runtime.intents.length
    runtime.emit({
      kind: 'screen',
      operationId: 'op-a',
      revision: 1,
      reconcileAttempt: 1,
      sequence: 1,
      state: 'error',
      source,
      participantIdentity: 'user-1:desktop-native:op-a:screen',
      errorCode: 'runtime_lost',
      errorMessage: 'runtime lost',
      errorStage: 'publish',
      retryable: true,
    })

    expect(observed).toHaveBeenCalledTimes(1)
    expect(runtime.intents).toHaveLength(applyCountBeforeError)
    expect(runtime.intents.at(-1)?.screen).toMatchObject({ state: 'publish' })
  })

  it('does not bump or reapply when the desired kind state is unchanged', async () => {
    const runtime = createDesktop()
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => runtime.desktop as never)
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))

    await owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })
    const applyCountAfterFirstPublish = runtime.intents.length
    const firstMicRevision = runtime.intents.at(-1)?.microphone.revision

    await owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })
    await owner.prepareScreenShare({
      sourceId: 'screen:1',
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 4_000_000,
      audioBitrate: 96_000,
      audioRequested: false,
    })
    const applyCountAfterPrepare = runtime.intents.length
    const prepareRevision = runtime.intents.at(-1)?.screen.revision
    await owner.prepareScreenShare({
      sourceId: 'screen:1',
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 4_000_000,
      audioBitrate: 96_000,
      audioRequested: false,
    })

    expect(runtime.intents).toHaveLength(applyCountAfterPrepare)
    expect(runtime.intents.at(-1)?.screen.revision).toBe(prepareRevision)
    expect(applyCountAfterFirstPublish).toBeGreaterThan(0)
    expect(runtime.intents[applyCountAfterFirstPublish - 1]?.microphone.revision).toBe(
      firstMicRevision,
    )
  })

  it('reapplies on same-operation lease refresh only when credentials materially change', async () => {
    const runtime = createDesktop()
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => runtime.desktop as never)
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))
    await owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })

    const applyCountBeforeRefresh = runtime.intents.length
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))
    expect(runtime.intents).toHaveLength(applyCountBeforeRefresh)

    owner.setLiveKitCredentials({
      ...lease('op-a', 'voice-a'),
      credentials: {
        ...lease('op-a', 'voice-a').credentials,
        microphone: {
          ...lease('op-a', 'voice-a').credentials.microphone,
          token: 'mic-op-a-refreshed',
        },
      },
    })

    expect(runtime.intents).toHaveLength(applyCountBeforeRefresh + 1)
    expect(runtime.intents.at(-1)?.operationId).toBe('op-a')
    expect(runtime.intents.at(-1)?.microphone).toMatchObject({
      state: 'publish',
      credentials: {
        token: 'mic-op-a-refreshed',
      },
    })
    expect(runtime.intents.at(-1)?.microphone.revision).toBe(
      (runtime.intents.at(-2)?.microphone.revision ?? 0) + 1,
    )
  })

  it('fences observed sequence independently per kind', async () => {
    const runtime = createDesktop()
    const micObserved = vi.fn()
    const screenObserved = vi.fn()
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => runtime.desktop as never, {
      onMicrophoneState: micObserved,
      onScreenState: screenObserved,
    })
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))
    await owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })
    const screenRevision = await owner.publishScreenShare({
      sourceId: 'screen:1',
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 4_000_000,
      audioBitrate: 96_000,
      audioRequested: false,
    })

    runtime.emit({
      kind: 'microphone',
      operationId: 'op-a',
      revision: 1,
      reconcileAttempt: 1,
      sequence: 3,
      state: 'published',
      muted: false,
      audioBitrateKbps: 96,
      participantIdentity: 'user-1:desktop-native:op-a:microphone',
    })
    runtime.emit({
      kind: 'microphone',
      operationId: 'op-a',
      revision: 1,
      reconcileAttempt: 99,
      sequence: 2,
      state: 'publishing',
      muted: false,
      audioBitrateKbps: 96,
      participantIdentity: 'user-1:desktop-native:op-a:microphone',
    })
    runtime.emit({
      kind: 'screen',
      operationId: 'op-a',
      revision: screenRevision,
      reconcileAttempt: 1,
      sequence: 1,
      state: 'prepared',
      source: {
        sourceId: 'screen:1',
        width: 1280,
        height: 720,
        fps: 30,
        bitrate: 4_000_000,
        audioBitrate: 96_000,
        audioRequested: false,
      },
      participantIdentity: 'user-1:desktop-native:op-a:screen',
    })

    expect(micObserved).toHaveBeenCalledTimes(1)
    expect(screenObserved).toHaveBeenCalledTimes(1)
    expect(micObserved.mock.calls[0]?.[0]).toMatchObject({
      state: 'published',
      sequence: 3,
    })
  })

  it('retries the same desired intent after apply rejection instead of latching a fake applied state', async () => {
    const intents: LocalMediaIntent[] = []
    const desktop = {
      platform: { os: 'win32' as const },
      media: {
        applyLocalMediaIntent: vi
          .fn()
          .mockImplementationOnce(async (intent: LocalMediaIntent) => {
            intents.push(intent)
            return {
              operationId: intent.operationId,
              acceptedEnvelopeRevision: intent.envelopeRevision,
              disposition: 'accepted' as const,
            }
          })
          .mockImplementationOnce(async (intent: LocalMediaIntent) => {
            intents.push(intent)
            return {
              operationId: intent.operationId,
              acceptedEnvelopeRevision: intent.envelopeRevision,
              disposition: 'accepted' as const,
            }
          })
          .mockImplementationOnce(async (intent: LocalMediaIntent) => {
            intents.push(intent)
            throw new Error('stale_intent')
          })
          .mockImplementation(async (intent: LocalMediaIntent) => {
            intents.push(intent)
            return {
              operationId: intent.operationId,
              acceptedEnvelopeRevision: intent.envelopeRevision,
              disposition: 'accepted' as const,
            }
          }),
        onLocalMediaState: vi.fn(() => () => {}),
      },
    }
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => desktop as never)
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))

    await expect(
      owner.syncMicrophone({
        enabled: true,
        muted: false,
        audioBitrateKbps: 96,
      }),
    ).rejects.toThrow('stale_intent')

    await owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })

    expect(intents).toHaveLength(4)
    expect(intents[1]?.microphone).toMatchObject({ state: 'off' })
    expect(intents[2]?.microphone).toMatchObject({ state: 'publish' })
    expect(intents[3]).toEqual(intents[2])
  })

  it('reports fire-and-forget intent application errors explicitly', async () => {
    const onIntentError = vi.fn()
    const desktop = {
      platform: { os: 'win32' as const },
      media: {
        applyLocalMediaIntent: vi
          .fn()
          .mockResolvedValueOnce({
            operationId: 'op-a',
            acceptedEnvelopeRevision: 1,
            disposition: 'accepted' as const,
          })
          .mockRejectedValueOnce(new Error('runtime_lost')),
        onLocalMediaState: vi.fn(() => () => {}),
      },
    }
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => desktop as never, { onIntentError })
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))

    await Promise.resolve()
    await Promise.resolve()

    expect(onIntentError).toHaveBeenCalledTimes(1)
    expect(onIntentError.mock.calls[0]?.[0]).toMatchObject({
      message: 'runtime_lost',
    })
    expect(onIntentError.mock.calls[0]?.[1]).toMatchObject({
      operationId: 'op-a',
    })
  })

  it('rejects a screen waiter immediately when a newer revision supersedes it', async () => {
    const runtime = createDesktop()
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => runtime.desktop as never)
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))
    const source = {
      sourceId: 'screen:1',
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 4_000_000,
      audioBitrate: 96_000,
      audioRequested: false,
    }
    const prepareRevision = await owner.prepareScreenShare(source)
    const prepared = owner.waitForScreenState(
      prepareRevision,
      ['prepared'],
      10_000,
    )

    await owner.publishScreenShare(source)

    await expect(prepared).rejects.toThrow('superseded')
  })

  it('uses only the declarative renderer API surface', async () => {
    const runtime = createDesktop()
    const owner = createVoiceNativeMediaOwner()
    owner.bindDesktop(() => runtime.desktop as never)
    owner.setVoiceContext({ operationId: 'op-a', channelId: 'voice-a' })
    owner.setLiveKitCredentials(lease('op-a', 'voice-a'))
    await owner.syncMicrophone({
      enabled: true,
      muted: false,
      audioBitrateKbps: 96,
    })

    expect(runtime.desktop.media.applyLocalMediaIntent).toHaveBeenCalled()
    expect('startSession' in runtime.desktop.media).toBe(false)
    expect('stopSession' in runtime.desktop.media).toBe(false)
    expect('reconnectMicrophoneSession' in runtime.desktop.media).toBe(false)
    expect('setMicrophoneMuted' in runtime.desktop.media).toBe(false)
  })
})
