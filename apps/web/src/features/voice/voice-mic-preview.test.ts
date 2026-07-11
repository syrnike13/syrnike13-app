import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { getSyrnikeDesktop } from '#/platform/runtime'

import {
  meterLevelsFromRms,
  MIC_PREVIEW_METER_BAR_COUNT,
  startMicPreview,
  type MicPreviewPreferences,
} from './voice-mic-preview'

vi.mock('#/platform/runtime', () => ({
  getSyrnikeDesktop: vi.fn(() => null),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.mocked(getSyrnikeDesktop).mockReturnValue(null)
})

describe('meterLevelsFromRms', () => {
  it('returns higher bars for louder input', () => {
    const quiet = meterLevelsFromRms(0.01, MIC_PREVIEW_METER_BAR_COUNT)
    const loud = meterLevelsFromRms(0.2, MIC_PREVIEW_METER_BAR_COUNT)

    const quietAvg = quiet.reduce((sum, value) => sum + value, 0) / quiet.length
    const loudAvg = loud.reduce((sum, value) => sum + value, 0) / loud.length

    expect(loudAvg).toBeGreaterThan(quietAvg)
  })
})

describe('native microphone processing boundary', () => {
  it('does not reference RNNoise from the web voice package', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const files = [
      'apps/web/package.json',
      'apps/web/vite.config.ts',
      'apps/web/src/features/voice/voice-mic-processor.ts',
      'apps/web/src/features/voice/native-microphone-publish.ts',
      'apps/web/src/features/voice/voice-provider.tsx',
    ]

    for (const file of files) {
      const source = readFileSync(resolve(repoRoot, file), 'utf8')
      expect(source.toLowerCase()).not.toContain('rnnoise')
    }
  })

  it('delegates Windows preview to the native runtime without browser capture', async () => {
    const getUserMedia = vi.fn()
    const startMicrophonePreview = vi.fn(async () => {})
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      voice: { dispatch: vi.fn(async () => undefined) },
      media: {
        startMicrophonePreview,
        stopMicrophonePreview: vi.fn(async () => {}),
        onMicrophoneMetrics: vi.fn(() => () => {}),
        onMicrophonePreviewState: vi.fn(() => () => {}),
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    const preview = await startMicPreview({
      prefs: {
        noiseSuppression: true,
        echoCancellation: true,
        voiceGateEnabled: true,
        voiceGateThresholdDb: -28,
        voiceGateAutoThreshold: true,
        inputVolume: 1,
        outputVolume: 1,
      },
      onLevels: vi.fn(),
    })

    expect(startMicrophonePreview).toHaveBeenCalledTimes(1)
    expect(getUserMedia).not.toHaveBeenCalled()
    preview.stop()
  })

  it('configures native preview gate and input gain without restarting preview', async () => {
    vi.useFakeTimers()
    const startMicrophonePreview = vi.fn(async () => {})
    const voiceDispatch = vi.fn(async () => undefined)
    const stopMicrophonePreview = vi.fn(async () => {})
    const unsubscribeMetrics = vi.fn()
    const microphoneMetricsHandlerRef: {
      current?: (event: {
          inputDb: number
          thresholdDb: number
          open: boolean
        }) => void
    } = {}
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      voice: { dispatch: voiceDispatch },
      media: {
        startMicrophonePreview,
        stopMicrophonePreview,
        onMicrophoneMetrics: vi.fn((handler) => {
          microphoneMetricsHandlerRef.current = handler
          return unsubscribeMetrics
        }),
        onMicrophonePreviewState: vi.fn(() => () => {}),
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    const prefs: MicPreviewPreferences = {
      noiseSuppression: true,
      echoCancellation: true,
      voiceGateEnabled: true,
      voiceGateThresholdDb: -28,
      voiceGateAutoThreshold: true,
      inputVolume: 1,
      outputVolume: 1,
    }

    const onLevels = vi.fn()
    const onGateMetrics = vi.fn()
    const session = await startMicPreview({
      inputDeviceId: 'mic-1',
      prefs,
      onLevels,
      onGateMetrics,
    })
    microphoneMetricsHandlerRef.current?.({
      inputDb: -24,
      thresholdDb: -28,
      open: true,
    })
    microphoneMetricsHandlerRef.current?.({
      inputDb: -6,
      thresholdDb: -28,
      open: true,
    })

    session.updateGatePreferences({
      ...prefs,
      voiceGateThresholdDb: -18,
    })
    await session.restartProcessing({
      ...prefs,
      noiseSuppression: false,
      voiceGateEnabled: false,
      inputVolume: 1.5,
    })
    await vi.advanceTimersByTimeAsync(39)

    expect(startMicrophonePreview).toHaveBeenCalledTimes(1)
    expect(startMicrophonePreview).toHaveBeenCalledWith()
    expect(stopMicrophonePreview).not.toHaveBeenCalled()
    expect(voiceDispatch).toHaveBeenCalledTimes(1)
    expect(voiceDispatch).toHaveBeenNthCalledWith(1, {
      type: 'configureMicrophone',
      deviceId: 'mic-1',
      noiseSuppression: true,
      echoCancellation: true,
      inputVolume: 1,
      voiceGateEnabled: true,
      voiceGateThresholdDb: -28,
      voiceGateAutoThreshold: true,
    })
    expect(onLevels).toHaveBeenCalledTimes(2)
    expect(onGateMetrics).toHaveBeenLastCalledWith({
      inputDb: -6,
      thresholdDb: -28,
      open: true,
    })
    expect(onGateMetrics).toHaveBeenCalledWith({
      inputDb: -24,
      thresholdDb: -28,
      open: true,
    })

    await vi.advanceTimersByTimeAsync(1)

    expect(voiceDispatch).toHaveBeenCalledTimes(2)
    expect(voiceDispatch).toHaveBeenLastCalledWith({
      type: 'configureMicrophone',
      deviceId: 'mic-1',
      noiseSuppression: false,
      echoCancellation: true,
      inputVolume: 1.5,
      voiceGateEnabled: false,
      voiceGateThresholdDb: -28,
      voiceGateAutoThreshold: true,
    })

    session.stop()
    expect(stopMicrophonePreview).toHaveBeenCalledWith()
    expect(unsubscribeMetrics).toHaveBeenCalled()
  })

  it('ends a native preview when the identity-free preview state becomes terminal', async () => {
    const stopMicrophonePreview = vi.fn(async () => {})
    const unsubscribeMetrics = vi.fn()
    const unsubscribeState = vi.fn()
    let previewStateHandler:
      | ((event:
          | { status: 'running' }
          | { status: 'stopped' }
          | { status: 'error'; message: string }) => void)
      | undefined
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      voice: { dispatch: vi.fn(async () => undefined) },
      media: {
        startMicrophonePreview: vi.fn(async () => {}),
        stopMicrophonePreview,
        onMicrophoneMetrics: vi.fn(() => unsubscribeMetrics),
        onMicrophonePreviewState: vi.fn((handler) => {
          previewStateHandler = handler
          return unsubscribeState
        }),
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)
    const onLevels = vi.fn()
    const onEnded = vi.fn()

    const preview = await startMicPreview({
      prefs: {
        noiseSuppression: true,
        echoCancellation: true,
        voiceGateEnabled: false,
        voiceGateThresholdDb: -45,
        voiceGateAutoThreshold: true,
        inputVolume: 1,
        outputVolume: 1,
      },
      onLevels,
      onEnded,
    })
    previewStateHandler?.({ status: 'running' })
    previewStateHandler?.({ status: 'error', message: 'render failed' })

    expect(onEnded).toHaveBeenCalledWith('render failed')
    expect(onLevels).toHaveBeenLastCalledWith(
      Array.from({ length: MIC_PREVIEW_METER_BAR_COUNT }, () => 0),
    )
    expect(unsubscribeMetrics).toHaveBeenCalledTimes(1)
    expect(unsubscribeState).toHaveBeenCalledTimes(1)
    preview.stop()
    expect(stopMicrophonePreview).not.toHaveBeenCalled()
  })
})
