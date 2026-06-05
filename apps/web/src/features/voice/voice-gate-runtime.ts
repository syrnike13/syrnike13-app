import type {
  AudioProcessorOptions,
  LocalAudioTrack,
  Track,
  TrackProcessor,
} from 'livekit-client'

import { normalizeVoiceGateThreshold, voiceGateOpen } from './voice-gate'

type VoiceGateProcessor = TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>

const SAMPLE_INTERVAL_MS = 50
const OPEN_HOLD_MS = 60
const CLOSE_HOLD_MS = 220

function rmsLevel(samples: Uint8Array) {
  let sum = 0
  for (const sample of samples) {
    const centered = (sample - 128) / 128
    sum += centered * centered
  }
  return Math.sqrt(sum / samples.length)
}

export class VoiceGateRuntime implements VoiceGateProcessor {
  name = 'syrnike-voice-gate'
  processedTrack?: MediaStreamTrack

  #threshold = 0.04
  #context: AudioContext | null = null
  #source: MediaStreamAudioSourceNode | null = null
  #analyser: AnalyserNode | null = null
  #gain: GainNode | null = null
  #samples: Uint8Array | null = null
  #timer: number | null = null
  #open = true
  #lastGateChangeAt = 0

  constructor(threshold: number) {
    this.#threshold = normalizeVoiceGateThreshold(threshold)
  }

  async init(options: AudioProcessorOptions) {
    this.#setup(options)
  }

  async restart(options: AudioProcessorOptions) {
    await this.destroy()
    this.#setup(options)
  }

  async destroy() {
    if (this.#timer !== null) {
      window.clearInterval(this.#timer)
      this.#timer = null
    }
    this.#source?.disconnect()
    this.#analyser?.disconnect()
    this.#gain?.disconnect()
    this.processedTrack?.stop()
    this.processedTrack = undefined
    this.#context = null
    this.#source = null
    this.#analyser = null
    this.#gain = null
    this.#samples = null
    this.#open = true
    this.#lastGateChangeAt = 0
  }

  #setup(options: AudioProcessorOptions) {
    const context = options.audioContext
    const source = context.createMediaStreamSource(
      new MediaStream([options.track]),
    )
    const analyser = context.createAnalyser()
    const gain = context.createGain()
    const destination = context.createMediaStreamDestination()

    analyser.fftSize = 512
    source.connect(analyser)
    source.connect(gain)
    gain.connect(destination)

    this.#context = context
    this.#source = source
    this.#analyser = analyser
    this.#gain = gain
    this.#samples = new Uint8Array(analyser.fftSize)
    this.processedTrack = destination.stream.getAudioTracks()[0]
    this.#open = true
    this.#lastGateChangeAt = Date.now()
    this.#timer = window.setInterval(() => this.#tick(), SAMPLE_INTERVAL_MS)
  }

  #tick() {
    if (!this.#analyser || !this.#samples || !this.#gain) return

    this.#analyser.getByteTimeDomainData(this.#samples)
    const shouldOpen = voiceGateOpen(
      rmsLevel(this.#samples),
      this.#threshold,
      true,
    )
    const now = Date.now()
    const holdMs = shouldOpen ? OPEN_HOLD_MS : CLOSE_HOLD_MS
    if (shouldOpen === this.#open) {
      this.#lastGateChangeAt = now
      return
    }
    if (now - this.#lastGateChangeAt < holdMs) return

    this.#open = shouldOpen
    this.#lastGateChangeAt = now
    this.#gain.gain.setTargetAtTime(
      shouldOpen ? 1 : 0,
      this.#context?.currentTime ?? 0,
      0.015,
    )
  }
}

export async function applyVoiceGateProcessor(
  audioTrack: LocalAudioTrack,
  enabled: boolean,
  threshold: number,
) {
  const current = audioTrack.getProcessor()
  if (!enabled) {
    if (current?.name === 'syrnike-voice-gate') {
      await audioTrack.stopProcessor()
    }
    return false
  }

  if (current?.name === 'syrnike-voice-gate') {
    await audioTrack.stopProcessor()
  }
  await audioTrack.setProcessor(new VoiceGateRuntime(threshold))
  return true
}
