import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getSyrnikeDesktop } from '#/platform/runtime'

import { AudioPresets, Track } from 'livekit-client'

import {
  createVoiceRoomOptions,
  fitScreenShareResolutionToLimits,
  screenShareAudioCaptureOptions,
  screenShareAudioPublishOptions,
  screenShareCaptureOptions,
  screenShareCombinedPublishOptions,
  voiceMicPublishOptions,
} from './voice-capture'
import { voicePreferenceStore } from './voice-preference-store'

vi.mock('#/platform/runtime', () => ({
  getSyrnikeDesktop: vi.fn(() => null),
}))

describe('createVoiceRoomOptions', () => {
  beforeEach(() => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue(null)
    voicePreferenceStore.setVoiceGateEnabled(true)
    voicePreferenceStore.setAutomaticGainControl(false)
  })

  it('captures microphone audio as mono voice', () => {
    const options = createVoiceRoomOptions()

    expect(options.audioCaptureDefaults?.channelCount).toBe(1)
  })

  it('keeps browser noise suppression and AGC disabled for voice capture', () => {
    const options = createVoiceRoomOptions()

    expect(options.audioCaptureDefaults?.noiseSuppression).toBe(false)
    expect(options.audioCaptureDefaults?.autoGainControl).toBe(false)
  })

  it('enables browser AGC when requested', () => {
    voicePreferenceStore.setAutomaticGainControl(true)

    expect(createVoiceRoomOptions().audioCaptureDefaults?.autoGainControl).toBe(true)
  })

  it('does not configure browser audio capture defaults on Windows desktop', () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      runtime: 'desktop',
      platform: { os: 'win32' },
    } as ReturnType<typeof getSyrnikeDesktop>)

    const options = createVoiceRoomOptions()

    expect(options.audioCaptureDefaults).toBeUndefined()
  })
})

describe('voiceMicPublishOptions', () => {
  it('publishes microphone audio with the speech preset and dtx', () => {
    expect(voiceMicPublishOptions(32)).toEqual({
      source: Track.Source.Microphone,
      audioPreset: { ...AudioPresets.speech, maxBitrate: 32_000 },
      dtx: true,
    })
  })
})

describe('screenShareAudioCaptureOptions', () => {
  it('disables voice processing and requests stereo capture', () => {
    expect(screenShareAudioCaptureOptions(false)).toBe(false)
    expect(screenShareAudioCaptureOptions(true)).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    })
  })
})

describe('screenShareAudioPublishOptions', () => {
  it('publishes screen share audio as stereo music without dtx', () => {
    expect(screenShareAudioPublishOptions(48)).toEqual({
      source: Track.Source.ScreenShareAudio,
      forceStereo: true,
      dtx: false,
      red: false,
      audioPreset: { ...AudioPresets.musicStereo, maxBitrate: 48_000 },
    })
  })
})

describe('screenShareCaptureOptions', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(getSyrnikeDesktop).mockReturnValue(null)
    voicePreferenceStore.setScreenShareCodec('auto')
    voicePreferenceStore.setScreenShareAudio(true)
  })

  it('publishes screen share as one high-quality browser stream', () => {
    vi.stubGlobal('RTCRtpSender', undefined)

    const options = screenShareCaptureOptions('high')

    expect(options.capture.audio).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    })
    expect(options.capture.contentHint).toBe('motion')
    expect(options.publish.screenShareEncoding).toEqual({
      maxBitrate: 8_000_000,
      maxFramerate: 30,
      priority: 'high',
    })
    expect(options.publish.simulcast).toBe(false)
    expect(options.publish.videoCodec).toBe('vp8')
    expect(options.publish.degradationPreference).toBe('maintain-resolution')
  })

  it('fits screen share resolution under server limits without changing aspect ratio wildly', () => {
    const resolution = fitScreenShareResolutionToLimits(
      { width: 1920, height: 1080, frameRate: 60 },
      { maxWidth: 1080, maxHeight: 720, maxPixels: 1080 * 720 },
    )

    expect(resolution.width).toBeLessThanOrEqual(1080)
    expect(resolution.height).toBeLessThanOrEqual(720)
    expect(resolution.width * resolution.height).toBeLessThanOrEqual(1080 * 720)
    expect(resolution.frameRate).toBe(60)
  })

  it('keeps FullHD screen share when server limits allow FullHD', () => {
    const resolution = fitScreenShareResolutionToLimits(
      { width: 1920, height: 1080, frameRate: 60 },
      { maxWidth: 1920, maxHeight: 1080, maxPixels: 1920 * 1080 },
    )

    expect(resolution).toEqual({ width: 1920, height: 1080, frameRate: 60 })
  })

  it('caps screen share bitrate with server screen-share limits', () => {
    const options = screenShareCaptureOptions('high', {
      maxWidth: 1920,
      maxHeight: 1080,
      maxPixels: 1920 * 1080,
      maxBitrate: 4_000_000,
    })

    expect(options.publish.screenShareEncoding?.maxBitrate).toBe(4_000_000)
  })

  it('uses av1 when the experimental toggle is enabled and av1 is advertised', () => {
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: () => ({
        codecs: [{ mimeType: 'video/AV1' }],
      }),
    })
    voicePreferenceStore.setScreenShareCodec('av1')

    const options = screenShareCaptureOptions('high60')

    expect(options.publish.videoCodec).toBe('av1')
  })

  it('falls back from av1 preference when av1 is not advertised', () => {
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: () => ({
        codecs: [{ mimeType: 'video/VP8' }],
      }),
    })
    voicePreferenceStore.setScreenShareCodec('av1')

    const options = screenShareCaptureOptions('high')

    expect(options.publish.videoCodec).toBe('vp8')
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

  it('prefers h264 on windows desktop for 1080p screen share when supported', () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      runtime: 'desktop',
      platform: { os: 'win32' },
    } as ReturnType<typeof getSyrnikeDesktop>)
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

    expect(options.publish.videoCodec).toBe('h264')
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
    expect(options.publish.screenShareEncoding?.maxBitrate).toBe(10_000_000)
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
    expect(options.publish.screenShareEncoding?.maxBitrate).toBe(8_000_000)
    expect(options.publish.screenShareEncoding?.maxFramerate).toBe(5)
  })
})

describe('screenShareCombinedPublishOptions', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(getSyrnikeDesktop).mockReturnValue(null)
    voicePreferenceStore.setScreenShareCodec('auto')
    voicePreferenceStore.setScreenShareAudio(true)
  })

  it('merges video publish defaults with stereo music audio settings', () => {
    vi.stubGlobal('RTCRtpSender', undefined)

    const options = screenShareCombinedPublishOptions('high', 96)

    expect(options.forceStereo).toBe(true)
    expect(options.dtx).toBe(false)
    expect(options.red).toBe(false)
    expect(options.audioPreset).toEqual({
      ...AudioPresets.musicStereo,
      maxBitrate: 96_000,
    })
    expect(options.screenShareEncoding?.maxBitrate).toBe(8_000_000)
  })
})
