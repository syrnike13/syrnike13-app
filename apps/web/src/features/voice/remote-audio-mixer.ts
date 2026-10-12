import {
  VOICE_USER_VOLUME_MAX,
  voiceListenerStore,
} from '#/features/voice/voice-listener-store'
import {
  VOICE_OUTPUT_VOLUME_MAX,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import {
  rmsFromFloatTimeDomain,
  rmsToDb,
} from '#/features/voice/voice-gate-level'
import { advanceSpeakingPolicy } from '#/features/voice/speaking-activity-policy'
import { Effect } from 'effect'

type AudioContextConstructor = typeof AudioContext

type BrowserWindowWithAudio = Window & {
  AudioContext?: AudioContextConstructor
  webkitAudioContext?: AudioContextConstructor
  __syrnikeRemoteAudioMixers?: Set<RemoteAudioMixer>
}

type AudioSinkIdTarget = {
  setSinkId?: (sinkId: string) => Promise<void>
}

export type RemoteAudioSource = 'mic' | 'stream'

type RemoteAudioMixerTrack = {
  trackId: string
  userId: string
  source: RemoteAudioSource
  mediaStreamTrack: MediaStreamTrack
}

type RemoteAudioMixerEntry = {
  trackId: string
  userId: string
  source: RemoteAudioSource
  mediaStreamTrack: MediaStreamTrack
  stream: MediaStream
  sourceNode: MediaStreamAudioSourceNode
  gainNode: GainNode
  analyserNode: AnalyserNode
  analyserSamples: Float32Array<ArrayBuffer>
  speaking: boolean
  quietSince: number | null
}

export type RemoteAudioMixerOptions = {
  onSpeakingUserIdsChange?: (userIds: ReadonlySet<string>) => void
  onOutputError?: (error: Error) => void
}

export type RemoteAudioMixerSnapshot = {
  trackId: string
  userId: string
  source: RemoteAudioSource
  gain: number
  mediaStreamTrack: {
    id: string
    enabled: boolean
    muted: boolean
    readyState: MediaStreamTrackState
  }
}

function audioContextConstructor() {
  if (typeof window === 'undefined') return undefined
  const browserWindow = window as BrowserWindowWithAudio
  return browserWindow.AudioContext ?? browserWindow.webkitAudioContext
}

function clampRemoteGain(gain: number) {
  if (!Number.isFinite(gain)) return 1
  return Math.min(
    VOICE_USER_VOLUME_MAX * VOICE_OUTPUT_VOLUME_MAX,
    Math.max(0, Number(gain.toFixed(3))),
  )
}

function applyOutputDeviceEffect(
  context: AudioContext,
  deviceId: string | undefined,
) {
  const sink = context as AudioContext & AudioSinkIdTarget
  const setSinkId = sink.setSinkId
  if (deviceId === undefined || !setSinkId) return Effect.void
  return Effect.tryPromise({
    try: () => setSinkId.call(sink, deviceId),
    catch: (cause) => cause,
  })
}

function applyElementOutputDeviceEffect(
  element: HTMLAudioElement,
  deviceId: string | undefined,
) {
  if (deviceId === undefined) return Effect.void
  if (!('setSinkId' in element)) {
    return Effect.fail(
      new Error('Audio output device selection is not supported'),
    )
  }
  return Effect.tryPromise({
    try: () => element.setSinkId(deviceId),
    catch: (cause) => cause,
  })
}

function registerMixer(mixer: RemoteAudioMixer) {
  if (typeof window === 'undefined') return
  const browserWindow = window as BrowserWindowWithAudio
  for (const activeMixer of browserWindow.__syrnikeRemoteAudioMixers ?? []) {
    activeMixer.dispose()
  }
  browserWindow.__syrnikeRemoteAudioMixers = new Set([mixer])
}

function unregisterMixer(mixer: RemoteAudioMixer) {
  if (typeof window === 'undefined') return
  const browserWindow = window as BrowserWindowWithAudio
  browserWindow.__syrnikeRemoteAudioMixers?.delete(mixer)
}

export class RemoteAudioMixer {
  #context: AudioContext | null = null
  #outputNode: MediaStreamAudioDestinationNode | null = null
  #outputElement: HTMLAudioElement | null = null
  #entries = new Map<string, RemoteAudioMixerEntry>()
  #speakingUserIds = new Set<string>()
  #speakingFrame: number | null = null
  #outputDeviceId: string | undefined
  #outputRetryArmed = false
  #disposed = false
  readonly #onSpeakingUserIdsChange:
    | ((userIds: ReadonlySet<string>) => void)
    | undefined
  readonly #onOutputError: ((error: Error) => void) | undefined

  constructor(options: RemoteAudioMixerOptions = {}) {
    this.#onSpeakingUserIdsChange = options.onSpeakingUserIdsChange
    this.#onOutputError = options.onOutputError
    registerMixer(this)
  }

  setOutputDevice(deviceId: string | undefined) {
    return Effect.runPromise(this.setOutputDeviceEffect(deviceId))
  }

  setOutputDeviceEffect(deviceId: string | undefined) {
    return Effect.suspend(() => {
      const previousDeviceId = this.#outputDeviceId
      this.#outputDeviceId = deviceId
      const sinkId = deviceId ?? (previousDeviceId ? '' : undefined)
      const context = this.#context
      const outputElement = this.#outputElement
      return Effect.all(
        [
          context
            ? applyOutputDeviceEffect(context, sinkId)
            : Effect.void,
          outputElement
            ? applyElementOutputDeviceEffect(outputElement, sinkId)
            : Effect.void,
        ],
        { concurrency: 'unbounded' },
      ).pipe(Effect.asVoid)
    })
  }

  addTrack(track: RemoteAudioMixerTrack) {
    if (this.#disposed) return false
    const context = this.#audioContext()
    if (!context) return false

    this.removeTrack(track.trackId)

    const stream = new MediaStream([track.mediaStreamTrack])
    try {
      const sourceNode = context.createMediaStreamSource(stream)
      const gainNode = context.createGain()
      const analyserNode = context.createAnalyser()
      const outputNode = this.#mediaOutputNode()
      if (!outputNode) {
        throw new Error('Remote audio output node is unavailable')
      }
      analyserNode.fftSize = 256
      analyserNode.smoothingTimeConstant = 0.2
      gainNode.gain.value = 0
      sourceNode.connect(gainNode)
      gainNode.connect(analyserNode)
      analyserNode.connect(outputNode)
      this.#entries.set(track.trackId, {
        trackId: track.trackId,
        userId: track.userId,
        source: track.source,
        mediaStreamTrack: track.mediaStreamTrack,
        stream,
        sourceNode,
        gainNode,
        analyserNode,
        analyserSamples: new Float32Array(analyserNode.fftSize),
        speaking: false,
        quietSince: null,
      })
      this.#scheduleSpeakingAnalysis()
      Effect.runFork(
        Effect.tryPromise({
          try: () => context.resume(),
          catch: (cause) => cause,
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => this.#reportOutputError(error)),
          ),
          Effect.ignore,
        ),
      )
      return true
    } catch {
      return false
    }
  }

  removeTrack(trackId: string) {
    const entry = this.#entries.get(trackId)
    if (!entry) return
    this.#releaseEntry(entry)
    this.#entries.delete(trackId)
    if (entry.speaking) {
      entry.speaking = false
      this.#publishSpeakingUsersIfChanged()
    }
  }

  removeMediaStreamTrack(track: MediaStreamTrack) {
    for (const entry of this.#entries.values()) {
      if (
        entry.mediaStreamTrack === track ||
        entry.mediaStreamTrack.id === track.id
      ) {
        this.removeTrack(entry.trackId)
      }
    }
  }

  applyVolumes(
    globallyDeafened: boolean,
    outputVolume = voicePreferenceStore.getState().outputVolume,
  ) {
    return Effect.runPromise(
      this.applyVolumesEffect(globallyDeafened, outputVolume),
    )
  }

  applyVolumesEffect(
    globallyDeafened: boolean,
    outputVolume = voicePreferenceStore.getState().outputVolume,
  ) {
    return Effect.gen({ self: this }, function*() {
      let speakingChanged = false
      for (const entry of this.#entries.values()) {
        const channelMuted =
          entry.source === 'stream'
            ? voiceListenerStore.getStreamMuted(entry.userId)
            : voiceListenerStore.getUserMuted(entry.userId)
        const channelVolume =
          entry.source === 'stream'
            ? voiceListenerStore.getStreamVolume(entry.userId)
            : voiceListenerStore.getUserVolume(entry.userId)
        const gain =
          globallyDeafened || channelMuted
            ? 0
            : clampRemoteGain(channelVolume * outputVolume)
        entry.gainNode.gain.value = gain
        if (gain <= 0 && entry.speaking) {
          entry.speaking = false
          entry.quietSince = null
          speakingChanged = true
        }
      }
      if (speakingChanged) {
        this.#publishSpeakingUsersIfChanged()
      }
      this.#scheduleSpeakingAnalysis()
      yield* this.#startOutputEffect()
    })
  }

  clear() {
    for (const entry of this.#entries.values()) {
      this.#releaseEntry(entry)
    }
    this.#entries.clear()
    if (this.#speakingFrame !== null) {
      window.cancelAnimationFrame(this.#speakingFrame)
      this.#speakingFrame = null
    }
    if (this.#speakingUserIds.size > 0) {
      this.#speakingUserIds = new Set()
      this.#onSpeakingUserIdsChange?.(new Set())
    }
    this.#outputElement?.remove()
    this.#outputElement = null
    this.#outputNode = null
    this.#disarmOutputRetry()
    const close = this.#context?.close()
    if (close) {
      Effect.runFork(
        Effect.tryPromise({
          try: () => close,
          catch: (cause) => cause,
        }).pipe(Effect.ignore),
      )
    }
    this.#context = null
  }

  dispose() {
    if (this.#disposed) return
    this.clear()
    this.#disposed = true
    unregisterMixer(this)
  }

  debugSnapshot(): RemoteAudioMixerSnapshot[] {
    return Array.from(this.#entries.values(), (entry) => ({
      trackId: entry.trackId,
      userId: entry.userId,
      source: entry.source,
      gain: entry.gainNode.gain.value,
      mediaStreamTrack: trackSnapshot(entry.mediaStreamTrack),
    }))
  }

  #audioContext() {
    if (this.#context) return this.#context
    const Context = audioContextConstructor()
    if (!Context) return null
    const context = new Context()
    this.#context = context
    Effect.runFork(
      applyOutputDeviceEffect(context, this.#outputDeviceId).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => this.#reportOutputError(error)),
        ),
        Effect.ignore,
      ),
    )
    return context
  }

  #mediaOutputNode() {
    if (this.#outputNode) return this.#outputNode
    const context = this.#audioContext()
    if (!context) return null

    this.#outputNode = context.createMediaStreamDestination()
    const element = document.createElement('audio')
    element.dataset.syrnikeRemoteAudioMixer = 'output'
    element.autoplay = true
    element.muted = false
    element.volume = 1
    element.srcObject = this.#outputNode.stream
    element.style.display = 'none'
    document.body.appendChild(element)
    this.#outputElement = element
    Effect.runFork(
      applyElementOutputDeviceEffect(element, this.#outputDeviceId).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => this.#reportOutputError(error)),
        ),
        Effect.ignore,
      ),
    )
    this.#startOutputBestEffort()
    return this.#outputNode
  }

  #startOutputEffect() {
    return Effect.suspend(() => {
      const context = this.#context
      const element = this.#outputElement
      if (!context || !element) return Effect.void
      return Effect.gen({ self: this }, function*() {
        yield* Effect.tryPromise({
          try: () => context.resume(),
          catch: (cause) => cause,
        })
        yield* Effect.tryPromise({
          try: () => element.play(),
          catch: (cause) => cause,
        })
        this.#disarmOutputRetry()
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            this.#armOutputRetry()
            this.#reportOutputError(error)
          }),
        ),
      )
    })
  }

  #armOutputRetry() {
    if (this.#disposed || this.#outputRetryArmed) return
    this.#outputRetryArmed = true
    document.addEventListener('pointerdown', this.#retryOutputFromGesture, true)
    document.addEventListener('keydown', this.#retryOutputFromGesture, true)
  }

  #disarmOutputRetry() {
    if (!this.#outputRetryArmed) return
    this.#outputRetryArmed = false
    document.removeEventListener('pointerdown', this.#retryOutputFromGesture, true)
    document.removeEventListener('keydown', this.#retryOutputFromGesture, true)
  }

  #retryOutputFromGesture = () => {
    this.#disarmOutputRetry()
    this.#startOutputBestEffort()
  }

  #startOutputBestEffort() {
    Effect.runFork(this.#startOutputEffect().pipe(Effect.ignore))
  }

  #reportOutputError(error: unknown) {
    this.#onOutputError?.(
      error instanceof Error ? error : new Error('Remote audio output failed'),
    )
  }

  #scheduleSpeakingAnalysis() {
    if (this.#disposed || this.#speakingFrame !== null) return
    if (!this.#onSpeakingUserIdsChange) return
    let hasMicEntry = false
    for (const entry of this.#entries.values()) {
      if (entry.source === 'mic') {
        hasMicEntry = true
        break
      }
    }
    if (!hasMicEntry) return
    this.#speakingFrame = window.requestAnimationFrame(() => {
      this.#speakingFrame = null
      this.#analyzeSpeaking()
      this.#scheduleSpeakingAnalysis()
    })
  }

  #analyzeSpeaking() {
    let changed = false
    const now = performance.now()

    for (const entry of this.#entries.values()) {
      if (entry.source !== 'mic') continue

      entry.analyserNode.getFloatTimeDomainData(entry.analyserSamples)
      const next = advanceSpeakingPolicy({
        state: entry,
        levelDb: rmsToDb(rmsFromFloatTimeDomain(entry.analyserSamples)),
        enabled:
          entry.gainNode.gain.value > 0 &&
          !entry.mediaStreamTrack.muted &&
          entry.mediaStreamTrack.readyState === 'live',
        now,
      })
      entry.quietSince = next.quietSince
      const speaking = next.speaking
      if (entry.speaking !== speaking) {
        entry.speaking = speaking
        changed = true
      }
    }

    if (changed) {
      this.#publishSpeakingUsersIfChanged()
    }
  }

  #publishSpeakingUsersIfChanged() {
    const next = new Set<string>()
    for (const entry of this.#entries.values()) {
      if (entry.source === 'mic' && entry.speaking) {
        next.add(entry.userId)
      }
    }

    if (sameStringSet(this.#speakingUserIds, next)) return
    this.#speakingUserIds = next
    this.#onSpeakingUserIdsChange?.(new Set(next))
  }

  #releaseEntry(entry: RemoteAudioMixerEntry) {
    entry.sourceNode.disconnect()
    entry.gainNode.disconnect()
    entry.analyserNode.disconnect()
  }
}

function trackSnapshot(track: MediaStreamTrack) {
  return {
    id: track.id,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
  }
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

export function createRemoteAudioMixer(options?: RemoteAudioMixerOptions) {
  return new RemoteAudioMixer(options)
}
