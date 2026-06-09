import {
  VOICE_USER_VOLUME_MAX,
  voiceListenerStore,
} from '#/features/voice/voice-listener-store'
import {
  VOICE_OUTPUT_VOLUME_MAX,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'

type AudioContextConstructor = typeof AudioContext

type BrowserWindowWithAudio = Window & {
  webkitAudioContext?: AudioContextConstructor
  __syrnikeRemoteAudioMixers?: Set<RemoteAudioMixer>
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

function applyOutputDevice(context: AudioContext, deviceId: string | undefined) {
  if (!deviceId || !('setSinkId' in context)) return
  void context.setSinkId(deviceId).catch(() => {})
}

function applyElementOutputDevice(
  element: HTMLAudioElement,
  deviceId: string | undefined,
) {
  if (!deviceId || !('setSinkId' in element)) return
  void element.setSinkId(deviceId).catch(() => {})
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
  #outputDeviceId: string | undefined
  #disposed = false

  constructor() {
    registerMixer(this)
  }

  setOutputDevice(deviceId: string | undefined) {
    this.#outputDeviceId = deviceId
    if (this.#context) {
      applyOutputDevice(this.#context, deviceId)
    }
    if (this.#outputElement) {
      applyElementOutputDevice(this.#outputElement, deviceId)
    }
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
      const outputNode = this.#mediaOutputNode()
      if (!outputNode) {
        throw new Error('Remote audio output node is unavailable')
      }
      gainNode.gain.value = 0
      sourceNode.connect(gainNode)
      gainNode.connect(outputNode)
      this.#entries.set(track.trackId, {
        trackId: track.trackId,
        userId: track.userId,
        source: track.source,
        mediaStreamTrack: track.mediaStreamTrack,
        stream,
        sourceNode,
        gainNode,
      })
      void context.resume().catch(() => {})
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

  applyVolumes(globallyDeafened: boolean) {
    for (const entry of this.#entries.values()) {
      const channelMuted =
        entry.source === 'stream'
          ? voiceListenerStore.getStreamMuted(entry.userId)
          : voiceListenerStore.getUserMuted(entry.userId)
      const channelVolume =
        entry.source === 'stream'
          ? voiceListenerStore.getStreamVolume(entry.userId)
          : voiceListenerStore.getUserVolume(entry.userId)
      const prefs = voicePreferenceStore.getState()
      const gain =
        globallyDeafened || channelMuted
          ? 0
          : clampRemoteGain(channelVolume * prefs.outputVolume)
      entry.gainNode.gain.value = gain
      this.#startOutput()
    }
  }

  clear() {
    for (const entry of this.#entries.values()) {
      this.#releaseEntry(entry)
    }
    this.#entries.clear()
    this.#outputElement?.remove()
    this.#outputElement = null
    this.#outputNode = null
    void this.#context?.close().catch(() => {})
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
    this.#context = new Context()
    applyOutputDevice(this.#context, this.#outputDeviceId)
    return this.#context
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
    applyElementOutputDevice(element, this.#outputDeviceId)
    this.#startOutput()
    return this.#outputNode
  }

  #startOutput() {
    const context = this.#context
    const element = this.#outputElement
    if (!context || !element) return
    void context.resume().catch((error) => {
      console.error('[voice-audio-mixer] failed to resume audio context', error)
    })
    void element.play().catch((error) => {
      console.error('[voice-audio-mixer] failed to play mixer output', error)
    })
  }

  #releaseEntry(entry: RemoteAudioMixerEntry) {
    entry.sourceNode.disconnect()
    entry.gainNode.disconnect()
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

export function createRemoteAudioMixer() {
  return new RemoteAudioMixer()
}
