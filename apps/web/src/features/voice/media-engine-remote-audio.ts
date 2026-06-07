import {
  remoteAudioElementVolume,
  remoteAutoBalanceGain,
} from '#/features/voice/remote-audio-settings'
import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import { voicePreferenceStore } from '#/features/voice/voice-preference-store'

type RemoteAudioStream = {
  userId: string
  sampleRate: number
  channels: number
  nextPlayTime: number
  gainNode: GainNode
  inputLevel: number
}

const streams = new Map<string, RemoteAudioStream>()
let audioContext: AudioContext | null = null
let masterGain: GainNode | null = null
let deafened = false
let outputDeviceId: string | undefined
let preferenceUnsubscribe: (() => void) | null = null
let listenerUnsubscribe: (() => void) | null = null

function rmsLevelFromPcm(samples: Int16Array, samplesPerChannel: number, channels: number) {
  if (samplesPerChannel === 0) return 0

  let sum = 0
  const count = samplesPerChannel * Math.max(1, channels)
  for (let index = 0; index < count; index += 1) {
    const centered = samples[index] / 32768
    sum += centered * centered
  }
  return Math.sqrt(sum / count)
}

function ensureContext(sampleRate: number) {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext({ sampleRate })
    masterGain = audioContext.createGain()
    masterGain.connect(audioContext.destination)
    void applyOutputDevice()
  }
  if (audioContext.state === 'suspended') {
    void audioContext.resume()
  }
  return audioContext
}

async function applyOutputDevice() {
  if (!audioContext) return
  const sinkContext = audioContext as AudioContext & {
    setSinkId?: (deviceId: string) => Promise<void>
  }
  if (!sinkContext.setSinkId) return

  try {
    await sinkContext.setSinkId(outputDeviceId ?? '')
  } catch {
    // Browser may reject unknown sink ids.
  }
}

function computeStreamGain(userId: string) {
  const userMuted = voiceListenerStore.getUserMuted(userId)
  const muted = deafened || userMuted
  const prefs = voicePreferenceStore.getState()
  const stream = streams.get(userId)
  const autoBalanceGain = remoteAutoBalanceGain(
    stream?.inputLevel ?? 0,
    prefs.autoBalanceStrength,
    prefs.autoBalanceEnabled,
  )
  return remoteAudioElementVolume(
    voiceListenerStore.getUserVolume(userId),
    prefs.outputVolume,
    muted,
    autoBalanceGain,
  )
}

function applyStreamGain(userId: string) {
  const stream = streams.get(userId)
  if (!stream || !masterGain) return
  stream.gainNode.gain.value = computeStreamGain(userId)
}

function applyAllStreamGains() {
  for (const userId of streams.keys()) {
    applyStreamGain(userId)
  }
}

function ensurePreferenceSubscriptions() {
  if (preferenceUnsubscribe && listenerUnsubscribe) return

  preferenceUnsubscribe = voicePreferenceStore.subscribe(() => {
    void applyOutputDevice()
    applyAllStreamGains()
  })
  listenerUnsubscribe = voiceListenerStore.subscribe(() => {
    applyAllStreamGains()
  })
}

export function setMediaEngineRemoteAudioDeafened(value: boolean) {
  deafened = value
  applyAllStreamGains()
}

export function refreshMediaEngineRemoteAudioGains() {
  ensurePreferenceSubscriptions()
  applyAllStreamGains()
}

export function setMediaEngineRemoteAudioOutputDevice(deviceId?: string) {
  ensurePreferenceSubscriptions()
  outputDeviceId = deviceId
  void applyOutputDevice()
}

export function playMediaEngineRemoteAudioFrame(
  userId: string,
  pcmBase64: string,
  sampleRate: number,
  channels: number,
  samplesPerChannel: number,
) {
  ensurePreferenceSubscriptions()

  const bytes = Uint8Array.from(atob(pcmBase64), (char) => char.charCodeAt(0))
  const samples = new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / 2,
  )
  if (samples.length === 0) return

  const context = ensureContext(sampleRate)
  if (!masterGain) return

  const stream =
    streams.get(userId) ??
    (() => {
      const gainNode = context.createGain()
      gainNode.connect(masterGain)
      const created: RemoteAudioStream = {
        userId,
        sampleRate,
        channels,
        nextPlayTime: context.currentTime,
        gainNode,
        inputLevel: 0,
      }
      streams.set(userId, created)
      applyStreamGain(userId)
      return created
    })()

  stream.inputLevel = rmsLevelFromPcm(samples, samplesPerChannel, channels)

  const audioBuffer = context.createBuffer(
    channels,
    samplesPerChannel,
    sampleRate,
  )

  if (channels === 1) {
    const channel = audioBuffer.getChannelData(0)
    for (let index = 0; index < samplesPerChannel; index += 1) {
      channel[index] = samples[index] / 32768
    }
  } else {
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const channel = audioBuffer.getChannelData(channelIndex)
      for (let index = 0; index < samplesPerChannel; index += 1) {
        channel[index] =
          samples[index * channels + channelIndex] / 32768
      }
    }
  }

  const source = context.createBufferSource()
  source.buffer = audioBuffer
  source.connect(stream.gainNode)

  const startAt = Math.max(stream.nextPlayTime, context.currentTime)
  source.start(startAt)
  stream.nextPlayTime = startAt + audioBuffer.duration
  applyStreamGain(userId)
}

export function stopMediaEngineRemoteAudio(userId?: string) {
  if (userId) {
    streams.delete(userId)
    return
  }
  streams.clear()
}

export function disposeMediaEngineRemoteAudio() {
  preferenceUnsubscribe?.()
  listenerUnsubscribe?.()
  preferenceUnsubscribe = null
  listenerUnsubscribe = null
  stopMediaEngineRemoteAudio()
  masterGain = null
  if (audioContext && audioContext.state !== 'closed') {
    void audioContext.close()
  }
  audioContext = null
  outputDeviceId = undefined
}
