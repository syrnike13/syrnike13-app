type RemoteAudioStream = {
  userId: string
  sampleRate: number
  channels: number
  nextPlayTime: number
}

const streams = new Map<string, RemoteAudioStream>()
let audioContext: AudioContext | null = null
let deafened = false

function ensureContext(sampleRate: number) {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext({ sampleRate })
  }
  if (audioContext.state === 'suspended') {
    void audioContext.resume()
  }
  return audioContext
}

export function setMediaEngineRemoteAudioDeafened(value: boolean) {
  deafened = value
}

export function playMediaEngineRemoteAudioFrame(
  userId: string,
  pcmBase64: string,
  sampleRate: number,
  channels: number,
  samplesPerChannel: number,
) {
  if (deafened) return

  const bytes = Uint8Array.from(atob(pcmBase64), (char) => char.charCodeAt(0))
  const samples = new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / 2,
  )
  if (samples.length === 0) return

  const context = ensureContext(sampleRate)
  const stream =
    streams.get(userId) ??
    ({
      userId,
      sampleRate,
      channels,
      nextPlayTime: context.currentTime,
    } satisfies RemoteAudioStream)

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
  source.connect(context.destination)

  const startAt = Math.max(stream.nextPlayTime, context.currentTime)
  source.start(startAt)
  stream.nextPlayTime = startAt + audioBuffer.duration
  streams.set(userId, stream)
}

export function stopMediaEngineRemoteAudio(userId?: string) {
  if (userId) {
    streams.delete(userId)
    return
  }
  streams.clear()
}

export function disposeMediaEngineRemoteAudio() {
  stopMediaEngineRemoteAudio()
  if (audioContext && audioContext.state !== 'closed') {
    void audioContext.close()
  }
  audioContext = null
}
