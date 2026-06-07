import type { SyrnikeDesktopApi } from '@syrnike13/platform'

const SAMPLE_RATE = 48_000
const CHANNELS = 2

export type NativeAudioBridgeHandle = {
  track: MediaStreamTrack
  stop: () => void
}

function waitForQueueData(queue: Uint8Array[]) {
  return new Promise<void>((resolve) => {
    const tick = () => {
      if (queue.length > 0) {
        resolve()
        return
      }
      window.setTimeout(tick, 5)
    }
    tick()
  })
}

export async function createNativeScreenShareAudioTrack(
  desktop: SyrnikeDesktopApi,
  sessionId: string,
): Promise<NativeAudioBridgeHandle> {
  if (typeof MediaStreamTrackGenerator === 'undefined') {
    throw new Error('MediaStreamTrackGenerator is not supported')
  }
  if (typeof AudioData === 'undefined') {
    throw new Error('WebCodecs audio bridge is not supported')
  }

  const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
  const writer = generator.writable.getWriter()

  const packetQueue: Uint8Array[] = []
  let ended = false
  let bridgeError: Error | null = null
  let timestampUs = 0

  const unsubscribeChunk = desktop.media.onStreamAudioChunk((event) => {
    if (event.sessionId !== sessionId) return
    packetQueue.push(new Uint8Array(event.chunk))
  })

  const unsubscribeEnded = desktop.media.onStreamEnded((id) => {
    if (id === sessionId) ended = true
  })

  const unsubscribeError = desktop.media.onStreamError((event) => {
    if (event.sessionId !== sessionId) return
    bridgeError = new Error(event.message)
  })

  const pump = async () => {
    while (!ended && !bridgeError) {
      await waitForQueueData(packetQueue)
      const packet = packetQueue.shift()
      if (!packet) continue

      // Main already strips TCP length prefix; each IPC chunk is one PCM packet.
      if (packet.byteLength < CHANNELS * 4) continue

      const interleaved = new Float32Array(
        packet.buffer,
        packet.byteOffset,
        Math.floor(packet.byteLength / 4),
      )
      const frames = Math.floor(interleaved.length / CHANNELS)
      if (frames === 0) continue

      try {
        const audioData = new AudioData({
          format: 'f32',
          sampleRate: SAMPLE_RATE,
          numberOfFrames: frames,
          numberOfChannels: CHANNELS,
          timestamp: timestampUs,
          data: interleaved,
        })

        await writer.write(audioData)
        audioData.close()
        timestampUs += Math.round((frames / SAMPLE_RATE) * 1_000_000)
      } catch (error) {
        bridgeError =
          error instanceof Error ? error : new Error(String(error))
        break
      }
    }
  }

  void pump().catch(() => {
    ended = true
  })

  const stop = () => {
    ended = true
    unsubscribeChunk()
    unsubscribeEnded()
    unsubscribeError()
    void writer.close()
  }

  return {
    track: generator,
    stop,
  }
}
