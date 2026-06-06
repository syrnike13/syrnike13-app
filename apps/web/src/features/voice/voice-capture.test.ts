import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createVoiceRoomOptions, screenShareCaptureOptions } from './voice-capture'
import { voicePreferenceStore } from './voice-preference-store'

describe('createVoiceRoomOptions', () => {
  beforeEach(() => {
    voicePreferenceStore.setNoiseSuppression('browser')
    voicePreferenceStore.setVoiceGateEnabled(false)
  })

  it('captures microphone audio as mono voice', () => {
    const options = createVoiceRoomOptions()

    expect(options.audioCaptureDefaults?.channelCount).toBe(1)
  })

  it('keeps browser noise suppression for enhanced mode when voice gate owns mic processing', () => {
    voicePreferenceStore.setNoiseSuppression('enhanced')
    voicePreferenceStore.setVoiceGateEnabled(true)

    const options = createVoiceRoomOptions()

    expect(options.audioCaptureDefaults?.noiseSuppression).toBe(true)
  })

  it('keeps enhanced mode free of browser noise suppression when the enhanced processor can run', () => {
    voicePreferenceStore.setNoiseSuppression('enhanced')
    voicePreferenceStore.setVoiceGateEnabled(false)

    const options = createVoiceRoomOptions()

    expect(options.audioCaptureDefaults?.noiseSuppression).toBe(false)
  })
})

describe('screenShareCaptureOptions', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    voicePreferenceStore.setScreenShareCodec('auto')
  })

  it('publishes screen share as one high-quality browser stream', () => {
    vi.stubGlobal('RTCRtpSender', undefined)

    const options = screenShareCaptureOptions('high')

    expect(options.capture.contentHint).toBe('motion')
    expect(options.publish.screenShareEncoding).toEqual({
      maxBitrate: 4_000_000,
      maxFramerate: 30,
      priority: 'high',
    })
    expect(options.publish.simulcast).toBe(false)
    expect(options.publish.videoCodec).toBe('vp8')
    expect(options.publish.degradationPreference).toBe('maintain-resolution')
  })

  it('uses av1 when the experimental toggle is enabled', () => {
    voicePreferenceStore.setScreenShareCodec('av1')

    const options = screenShareCaptureOptions('high60')

    expect(options.publish.videoCodec).toBe('av1')
  })

  it('uses vp9 automatically for high quality screen share when supported', () => {
    voicePreferenceStore.setScreenShareCodec('auto')
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: () => ({
        codecs: [
          { mimeType: 'video/VP8' },
          { mimeType: 'video/H264' },
          { mimeType: 'video/VP9' },
        ],
      }),
    })

    const options = screenShareCaptureOptions('high')

    expect(options.publish.videoCodec).toBe('vp9')
  })

  it('uses h264 automatically for 60 fps screen share when supported', () => {
    voicePreferenceStore.setScreenShareCodec('auto')
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: () => ({
        codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264' }],
      }),
    })

    const options = screenShareCaptureOptions('high60')

    expect(options.publish.videoCodec).toBe('h264')
  })

  it('falls back to vp8 when automatic codec capabilities are unavailable', () => {
    voicePreferenceStore.setScreenShareCodec('auto')
    vi.stubGlobal('RTCRtpSender', undefined)

    const options = screenShareCaptureOptions('text')

    expect(options.publish.videoCodec).toBe('vp8')
  })

  it('uses text capture hint before publishing text-focused screen share', () => {
    const options = screenShareCaptureOptions('text')

    expect(options.capture.contentHint).toBe('text')
    expect(options.publish.screenShareEncoding?.maxFramerate).toBe(5)
  })
})
