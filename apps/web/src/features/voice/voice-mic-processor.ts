import type {
  AudioProcessorOptions,
  Track,
  TrackProcessor,
} from 'livekit-client'

import {
  effectiveVoiceGateStageOptions,
  resolveVoiceGateStageOptions,
} from '#/features/voice/voice-gate-session'
import { VoiceGateStage } from '#/features/voice/voice-gate-stage'
import type {
  VoiceGateMetrics,
  VoiceGateStageOptions,
} from '#/features/voice/voice-gate-stage'
import { VoiceInputGainStage } from '#/features/voice/voice-input-gain-stage'
import { notifyDenoiseUnavailableOnce } from '#/features/voice/voice-mic-denoise-notify'
import { rnnoiseWorkletBaseUrl } from '#/features/voice/voice-rnnoise-assets'

export const SYRNIKE_MIC_PROCESSOR_NAME = 'syrnike-mic-processor'

export type SyrnikeMicProcessorConfig = {
  denoiseEnabled: boolean
  gateEnabled: boolean
  gateThresholdDb: number
  gateAutoThreshold: boolean
  gateStageOptions?: VoiceGateStageOptions
  gateOnMetrics?: (metrics: VoiceGateMetrics) => void
  inputVolume: number
}

type DenoiseProcessor = TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>

async function createDenoiseProcessor() {
  const { DenoiseTrackProcessor } = await import('livekit-rnnoise-processor')
  return new DenoiseTrackProcessor({
    workletCDNURL: rnnoiseWorkletBaseUrl(),
  })
}

export function micProcessingNeeded(config: SyrnikeMicProcessorConfig) {
  return (
    config.denoiseEnabled ||
    config.gateEnabled ||
    config.inputVolume !== 1
  )
}

export function createMicProcessorConfigFromPrefs(
  prefs: {
    noiseSuppression: 'disabled' | 'enhanced'
    voiceGateEnabled: boolean
    voiceGateThresholdDb: number
    voiceGateAutoThreshold: boolean
    inputVolume: number
  },
): SyrnikeMicProcessorConfig {
  return {
    denoiseEnabled: prefs.noiseSuppression === 'enhanced',
    gateEnabled: true,
    gateThresholdDb: prefs.voiceGateThresholdDb,
    gateAutoThreshold: prefs.voiceGateAutoThreshold,
    gateStageOptions: resolveVoiceGateStageOptions(prefs),
    inputVolume: prefs.inputVolume,
  }
}

export class SyrnikeMicProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = SYRNIKE_MIC_PROCESSOR_NAME
  processedTrack?: MediaStreamTrack

  readonly #config: SyrnikeMicProcessorConfig
  #denoise: DenoiseProcessor | null = null
  #gate: VoiceGateStage | null = null
  #inputGain: VoiceInputGainStage | null = null

  async whenGateCalibrated() {
    await this.#gate?.whenCalibrated()
  }

  updateGatePreferences(
    prefs: Pick<
      SyrnikeMicProcessorConfig,
      'gateThresholdDb' | 'gateAutoThreshold' | 'gateStageOptions'
    >,
  ) {
    this.#config.gateThresholdDb = prefs.gateThresholdDb
    this.#config.gateAutoThreshold = prefs.gateAutoThreshold
    this.#config.gateStageOptions = prefs.gateStageOptions
    this.#gate?.updateOptions({
      ...effectiveVoiceGateStageOptions(
        prefs.gateStageOptions,
        prefs.gateAutoThreshold,
        prefs.gateThresholdDb,
      ),
      onMetrics: this.#config.gateOnMetrics,
    })
  }

  constructor(config: SyrnikeMicProcessorConfig) {
    this.#config = config
  }

  async init(options: AudioProcessorOptions) {
    await this.#build(options)
  }

  async restart(options: AudioProcessorOptions) {
    await this.destroy()
    await this.#build(options)
  }

  async destroy() {
    this.#inputGain?.destroy()
    this.#gate?.destroy()
    if (this.#denoise) {
      await this.#denoise.destroy()
    }
    this.#inputGain = null
    this.#gate = null
    this.#denoise = null
    this.processedTrack = undefined
  }

  async #build(options: AudioProcessorOptions) {
    let track = options.track

    if (this.#config.denoiseEnabled) {
      try {
        const denoise = await createDenoiseProcessor()
        this.#denoise = denoise
        await denoise.init({ ...options, track })
        track = denoise.processedTrack ?? track
      } catch (error) {
        this.#denoise = null
        console.warn('[voice] RNNoise init failed', error)
        notifyDenoiseUnavailableOnce()
      }
    }

    if (this.#config.gateEnabled) {
      this.#gate = new VoiceGateStage(this.#config.gateThresholdDb)
      const gateOptions = effectiveVoiceGateStageOptions(
        this.#config.gateStageOptions,
        this.#config.gateAutoThreshold,
        this.#config.gateThresholdDb,
      )
      const gatedTrack = this.#gate.start(options.audioContext, track, {
        ...gateOptions,
        onMetrics: this.#config.gateOnMetrics,
      })
      if (gatedTrack) {
        track = gatedTrack
      }
    }

    if (this.#config.inputVolume !== 1) {
      this.#inputGain = new VoiceInputGainStage()
      const gainedTrack = this.#inputGain.start(
        options.audioContext,
        track,
        this.#config.inputVolume,
      )
      if (gainedTrack) {
        track = gainedTrack
      }
    }

    this.processedTrack = track
  }
}
