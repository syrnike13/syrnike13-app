import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  createInitialVoiceMediaDesiredState,
  type VoiceLease,
} from '@syrnike13/platform'

import {
  NATIVE_MEDIA_UNAVAILABLE_FAILURE,
  NativeRtcEngineAdapter,
} from './native-rtc-engine-adapter'

const lease: VoiceLease = {
  channelId: 'channel-a',
  rtcEngine: 'windows_native',
  clientInstanceId: 'desktop-a',
  operationId: 'op-a',
  connectionEpoch: 'epoch-a',
  authorityVersion: 1,
  credential: {
    url: 'wss://voice.invalid',
    token: 'token',
    participantIdentity: 'participant',
  },
}

describe('NativeRtcEngineAdapter', () => {
  it('publishes the unavailable boundary immediately', () => {
    const adapter = new NativeRtcEngineAdapter()
    const listener = vi.fn()

    const unsubscribe = adapter.subscribe(listener)

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({
      type: 'availabilityChanged',
      available: false,
      retryable: false,
      failure: NATIVE_MEDIA_UNAVAILABLE_FAILURE,
    })

    unsubscribe()
    adapter.dispose()
  })

  it('allows membership to commit without starting media work', async () => {
    const adapter = new NativeRtcEngineAdapter()

    await expect(
      adapter.connect(
        lease,
        createInitialVoiceMediaDesiredState(),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()

    await expect(adapter.disconnect('leave')).resolves.toBeUndefined()
    expect(adapter.telemetry()).toBeNull()
    adapter.dispose()
  })

  it('fails microphone prewarm without starting recovery work', async () => {
    const adapter = new NativeRtcEngineAdapter()

    await expect(
      Effect.runPromise(adapter.prewarmMicrophoneEffect()),
    ).rejects.toMatchObject({
      _tag: 'NativeMediaUnavailableError',
      failure: NATIVE_MEDIA_UNAVAILABLE_FAILURE,
    })

    adapter.updateDesiredMedia(createInitialVoiceMediaDesiredState())
    adapter.updateRemoteAudioSettings({
      revision: 0,
      userVolumes: {},
      userMutes: {},
      streamVolumes: {},
      streamMutes: {},
    })
    adapter.retryMedia('microphone')
    adapter.dispose()
  })
})
