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

export const SYRNIKE_MIC_PROCESSOR_NAME = 'syrnike-mic-processor'

export type SyrnikeMicProcessorConfig = {
  gateEnabled: boolean
  gateThresholdDb: number
  gateAutoThreshold: boolean
  gateStageOptions?: VoiceGateStageOptions
  gateOnMetrics?: (metrics: VoiceGateMetrics) => void
  inputVolume: number
}

export function micProcessingNeeded(config: SyrnikeMicProcessorConfig) {
  return (
    config.gateEnabled ||
    config.inputVolume !== 1
  )
}

export function createMicProcessorConfigFromPrefs(
  prefs: {
    voiceGateEnabled: boolean
    voiceGateThresholdDb: number
    voiceGateAutoThreshold: boolean
    inputVolume: number
  },
): SyrnikeMicProcessorConfig {
  return {
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
    this.#inputGain = null
    this.#gate = null
    this.processedTrack = undefined
  }

  async #build(options: AudioProcessorOptions) {
    let track = options.track

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
