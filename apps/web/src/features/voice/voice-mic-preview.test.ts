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

  it('initializes LiveKit before native preview uses the audio processor', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const source = readFileSync(
      resolve(
        repoRoot,
        'apps/desktop/native/native-voice-win/src/microphone_preview.cpp',
      ),
      'utf8',
    )

    const initializeIndex = source.indexOf('livekit::initialize')
    const processorIndex = source.indexOf('MicrophoneAudioProcessor processor')
    const shutdownIndex = source.indexOf('livekit::shutdown')

    expect(initializeIndex).toBeGreaterThanOrEqual(0)
    expect(processorIndex).toBeGreaterThan(initializeIndex)
    expect(shutdownIndex).toBeGreaterThan(processorIndex)
  })

  it('configures native preview gate and input gain without restarting preview', async () => {
    vi.useFakeTimers()
    const startMicrophonePreview = vi.fn(async () => ({ sessionId: 'preview-1' }))
    const configureMicrophoneRuntime = vi.fn(async () => {})
    const stopMicrophonePreview = vi.fn(async () => {})
    const unsubscribeMetrics = vi.fn()
    const microphoneMetricsHandlerRef: {
      current?: (event: {
          sessionId: string
          inputDb: number
          thresholdDb: number
          open: boolean
        }) => void
    } = {}
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startMicrophonePreview,
        configureMicrophoneRuntime,
        stopMicrophonePreview,
        onMicrophoneMetrics: vi.fn((handler) => {
          microphoneMetricsHandlerRef.current = handler
          return unsubscribeMetrics
        }),
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
      prefs,
      onLevels,
      onGateMetrics,
    })
    microphoneMetricsHandlerRef.current?.({
      sessionId: 'preview-1',
      inputDb: -24,
      thresholdDb: -28,
      open: true,
    })
    microphoneMetricsHandlerRef.current?.({
      sessionId: 'other-preview',
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
    expect(startMicrophonePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceGateAutoThreshold: true,
      }),
    )
    expect(stopMicrophonePreview).not.toHaveBeenCalled()
    expect(configureMicrophoneRuntime).not.toHaveBeenCalled()
    expect(onLevels).toHaveBeenCalledTimes(1)
    expect(onGateMetrics).toHaveBeenCalledWith({
      inputDb: -24,
      thresholdDb: -28,
      open: true,
    })

    await vi.advanceTimersByTimeAsync(1)

    expect(configureMicrophoneRuntime).toHaveBeenCalledTimes(1)
    expect(configureMicrophoneRuntime).toHaveBeenLastCalledWith(
      'preview-1',
      expect.objectContaining({
        voiceGateEnabled: false,
        voiceGateAutoThreshold: true,
        noiseSuppression: false,
        inputVolume: 1.5,
      }),
    )

    session.stop()
    expect(stopMicrophonePreview).toHaveBeenCalledWith('preview-1')
    expect(unsubscribeMetrics).toHaveBeenCalled()
  })
})
