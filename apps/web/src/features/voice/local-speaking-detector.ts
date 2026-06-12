import {
  rmsFromFloatTimeDomain,
  rmsToDb,
} from '#/features/voice/voice-gate-level'

const CLIENT_SPEAKING_THRESHOLD_DB = -58
const CLIENT_SPEAKING_CLOSE_HOLD_MS = 180

type AudioContextConstructor = typeof AudioContext

type BrowserWindowWithAudio = Window & {
  AudioContext?: AudioContextConstructor
  webkitAudioContext?: AudioContextConstructor
}

type LocalSpeakingDetectorEntry = {
  track: MediaStreamTrack
  stream: MediaStream
  sourceNode: MediaStreamAudioSourceNode
  analyserNode: AnalyserNode
  analyserSamples: Float32Array<ArrayBuffer>
  speaking: boolean
  quietSince: number | null
}

export type LocalSpeakingDetectorOptions = {
  onSpeakingChange: (speaking: boolean) => void
}

function audioContextConstructor() {
  if (typeof window === 'undefined') return undefined
  const browserWindow = window as BrowserWindowWithAudio
  return browserWindow.AudioContext ?? browserWindow.webkitAudioContext
}

export class LocalSpeakingDetector {
  #context: AudioContext | null = null
  #entry: LocalSpeakingDetectorEntry | null = null
  #enabled = false
  #frame: number | null = null
  #disposed = false

  readonly #onSpeakingChange: (speaking: boolean) => void

  constructor(options: LocalSpeakingDetectorOptions) {
    this.#onSpeakingChange = options.onSpeakingChange
  }

  setTrack(track: MediaStreamTrack | null) {
    if (this.#disposed) return false
    if (this.#entry?.track === track) {
      this.#scheduleAnalysis()
      return true
    }

    this.#releaseEntry()
    if (!track) return true

    const context = this.#audioContext()
    if (!context) return false

    try {
      const stream = new MediaStream([track])
      const sourceNode = context.createMediaStreamSource(stream)
      const analyserNode = context.createAnalyser()
      analyserNode.fftSize = 256
      analyserNode.smoothingTimeConstant = 0.2
      sourceNode.connect(analyserNode)
      this.#entry = {
        track,
        stream,
        sourceNode,
        analyserNode,
        analyserSamples: new Float32Array(analyserNode.fftSize),
        speaking: false,
        quietSince: null,
      }
      void context.resume().catch(() => {})
      this.#scheduleAnalysis()
      return true
    } catch {
      this.#releaseEntry()
      return false
    }
  }

  setEnabled(enabled: boolean) {
    if (this.#disposed || this.#enabled === enabled) return
    this.#enabled = enabled
    if (!enabled) {
      this.#setSpeaking(false)
      this.#cancelAnalysis()
      return
    }
    this.#scheduleAnalysis()
  }

  clear() {
    this.#releaseEntry()
  }

  dispose() {
    if (this.#disposed) return
    this.clear()
    this.#disposed = true
    void this.#context?.close().catch(() => {})
    this.#context = null
  }

  #audioContext() {
    if (this.#context) return this.#context
    const Context = audioContextConstructor()
    if (!Context) return null
    this.#context = new Context()
    return this.#context
  }

  #scheduleAnalysis() {
    if (this.#disposed || !this.#enabled || !this.#entry || this.#frame !== null) {
      return
    }
    this.#frame = window.requestAnimationFrame(() => {
      this.#frame = null
      this.#analyze()
      this.#scheduleAnalysis()
    })
  }

  #cancelAnalysis() {
    if (this.#frame === null) return
    window.cancelAnimationFrame(this.#frame)
    this.#frame = null
  }

  #analyze() {
    const entry = this.#entry
    if (!entry) return
    const speaking = this.#entrySpeaking(entry, performance.now())
    this.#setSpeaking(speaking)
  }

  #entrySpeaking(entry: LocalSpeakingDetectorEntry, now: number) {
    if (
      !this.#enabled ||
      entry.track.muted ||
      entry.track.readyState !== 'live'
    ) {
      entry.quietSince = null
      return false
    }

    entry.analyserNode.getFloatTimeDomainData(entry.analyserSamples)
    const levelDb = rmsToDb(rmsFromFloatTimeDomain(entry.analyserSamples))
    if (levelDb >= CLIENT_SPEAKING_THRESHOLD_DB) {
      entry.quietSince = null
      return true
    }

    if (!entry.speaking) {
      entry.quietSince = null
      return false
    }

    entry.quietSince ??= now
    return now - entry.quietSince < CLIENT_SPEAKING_CLOSE_HOLD_MS
  }

  #setSpeaking(speaking: boolean) {
    const entry = this.#entry
    if (!entry) {
      if (!speaking) this.#onSpeakingChange(false)
      return
    }
    if (entry.speaking === speaking) return
    entry.speaking = speaking
    this.#onSpeakingChange(speaking)
  }

  #releaseEntry() {
    const entry = this.#entry
    this.#entry = null
    this.#cancelAnalysis()
    if (!entry) return
    const wasSpeaking = entry.speaking
    entry.sourceNode.disconnect()
    entry.analyserNode.disconnect()
    if (wasSpeaking) this.#onSpeakingChange(false)
  }
}

export function createLocalSpeakingDetector(
  options: LocalSpeakingDetectorOptions,
) {
  return new LocalSpeakingDetector(options)
}
