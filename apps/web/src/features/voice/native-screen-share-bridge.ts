import type { NativeMediaStreamMode, SyrnikeDesktopApi } from '@syrnike13/platform'

import {
  avc1CodecString,
  avccFromNal,
  buildAvcC,
  extractSpsPps,
  nalChunkType,
  parseH264Nals,
} from '#/features/voice/h264-avcc'

export type NativeBridgeHandle = {
  track: MediaStreamTrack
  bindSession: (sessionId: string) => void
  waitForFirstFrame: (timeoutMs?: number) => Promise<void>
  getLastFrameDimensions: () => { width: number; height: number } | null
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

function readLengthPrefixedPacket(readBuffer: Uint8Array) {
  if (readBuffer.length < 4) return null
  const length = new DataView(
    readBuffer.buffer,
    readBuffer.byteOffset,
    readBuffer.byteLength,
  ).getUint32(0, true)
  if (readBuffer.length < 4 + length) return null
  const payload = readBuffer.slice(4, 4 + length)
  const remainder = readBuffer.slice(4 + length)
  return { payload, remainder }
}

export async function createNativeScreenShareTrack(
  desktop: SyrnikeDesktopApi,
  sessionId: string,
  streamMode: NativeMediaStreamMode = 'h264',
): Promise<NativeBridgeHandle> {
  if (typeof MediaStreamTrackGenerator === 'undefined') {
    throw new Error('MediaStreamTrackGenerator is not supported')
  }

  if (streamMode === 'bgra') {
    return createRawBgraTrack(desktop, sessionId)
  }

  if (typeof VideoDecoder === 'undefined') {
    throw new Error('WebCodecs screen share bridge is not supported')
  }

  const generator = new MediaStreamTrackGenerator({ kind: 'video' })
  const writer = generator.writable.getWriter()

  const packetQueue: Uint8Array[] = []
  let ended = false
  let decodeError: Error | null = null
  let timestamp = 0
  const frameDurationUs = 16_667
  let decoderConfigured = false
  let pendingConfig: VideoDecoderConfig | null = null
  let activeSessionId = sessionId
  let firstFrameWritten = false
  let resolveFirstFrame: (() => void) | null = null
  let lastFrameWidth = 0
  let lastFrameHeight = 0
  const firstFrameReady = new Promise<void>((resolve) => {
    resolveFirstFrame = resolve
  })

  const unsubscribeChunk = desktop.media.onStreamChunk((event) => {
    if (
      event.sessionId !== activeSessionId &&
      activeSessionId !== '__pending__'
    ) {
      return
    }
    if (activeSessionId === '__pending__') {
      activeSessionId = event.sessionId
    }
    packetQueue.push(new Uint8Array(event.chunk))
  })

  const unsubscribeEnded = desktop.media.onStreamEnded((id) => {
    if (id === activeSessionId) ended = true
  })

  const unsubscribeError = desktop.media.onStreamError((event) => {
    if (event.sessionId !== activeSessionId) return
    decodeError = new Error(event.message)
  })

  const decoder = new VideoDecoder({
    output: (frame) => {
      lastFrameWidth = frame.displayWidth
      lastFrameHeight = frame.displayHeight
      void writer.write(frame)
      if (!firstFrameWritten) {
        firstFrameWritten = true
        resolveFirstFrame?.()
        resolveFirstFrame = null
      }
      frame.close()
    },
    error: (error) => {
      decodeError = error instanceof Error ? error : new Error(String(error))
    },
  })

  const configureDecoder = (config: VideoDecoderConfig) => {
    if (decoderConfigured) {
      decoder.reset()
    }
    decoder.configure(config)
    decoderConfigured = true
    pendingConfig = null
  }

  let readBuffer = new Uint8Array()

  const pump = async () => {
    while (!ended && !decodeError) {
      await waitForQueueData(packetQueue)
      const packet = packetQueue.shift()
      if (!packet) continue

      const merged = new Uint8Array(readBuffer.length + packet.length)
      merged.set(readBuffer, 0)
      merged.set(packet, readBuffer.length)
      readBuffer = merged

      while (true) {
        const parsed = readLengthPrefixedPacket(readBuffer)
        if (!parsed) break
        readBuffer = parsed.remainder

        const nals = parseH264Nals(parsed.payload)
        if (!decoderConfigured) {
          const { sps, pps } = extractSpsPps(nals)
          if (sps && pps) {
            pendingConfig = {
              codec: avc1CodecString(sps),
              description: buildAvcC(sps, pps),
              optimizeForLatency: true,
            }
            configureDecoder(pendingConfig)
          }
        }

        for (const nal of nals) {
          if (nal.length === 0) continue
          if (!decoderConfigured) continue
          const chunkType = nalChunkType(nal)
          if (chunkType === 'skip') continue
          const chunk = new EncodedVideoChunk({
            type: chunkType,
            timestamp,
            data: avccFromNal(nal),
          })
          decoder.decode(chunk)
          timestamp += frameDurationUs
        }
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
    decoder.close()
    void writer.close()
    if (activeSessionId !== '__pending__') {
      void desktop.media.stopSession(activeSessionId)
    }
  }

  const waitForFirstFrame = (timeoutMs = 10_000) =>
    Promise.race([
      firstFrameReady,
      new Promise<void>((_resolve, reject) => {
        window.setTimeout(
          () => reject(new Error('Native media engine first frame timeout')),
          timeoutMs,
        )
      }),
    ])

  return {
    track: generator,
    bindSession: (nextSessionId: string) => {
      activeSessionId = nextSessionId
    },
    waitForFirstFrame,
    stop,
    getLastFrameDimensions: () =>
      lastFrameWidth > 0 && lastFrameHeight > 0
        ? { width: lastFrameWidth, height: lastFrameHeight }
        : null,
  }
}

async function createRawBgraTrack(
  desktop: SyrnikeDesktopApi,
  sessionId: string,
): Promise<NativeBridgeHandle> {
  const generator = new MediaStreamTrackGenerator({ kind: 'video' })
  const writer = generator.writable.getWriter()

  const packetQueue: Uint8Array[] = []
  let ended = false
  let bridgeError: Error | null = null
  let timestamp = 0
  const frameDurationUs = 16_667
  let firstFrameWritten = false
  let lastFrameWidth = 0
  let lastFrameHeight = 0
  let resolveFirstFrame: (() => void) | null = null
  const firstFrameReady = new Promise<void>((resolve) => {
    resolveFirstFrame = resolve
  })

  let activeSessionId = sessionId

  const unsubscribeChunk = desktop.media.onStreamChunk((event) => {
    if (
      event.sessionId !== activeSessionId &&
      activeSessionId !== '__pending__'
    ) {
      return
    }
    if (activeSessionId === '__pending__') {
      activeSessionId = event.sessionId
    }
    packetQueue.push(new Uint8Array(event.chunk))
    while (packetQueue.length > 2) {
      packetQueue.shift()
    }
  })

  const unsubscribeEnded = desktop.media.onStreamEnded((id) => {
    if (id === activeSessionId) ended = true
  })

  const unsubscribeError = desktop.media.onStreamError((event) => {
    if (event.sessionId !== activeSessionId) return
    bridgeError = new Error(event.message)
  })

  let readBuffer = new Uint8Array()
  let sharedReadInFlight = false

  const pump = async () => {
    while (!ended && !bridgeError) {
      await waitForQueueData(packetQueue)
      const packet = packetQueue.shift()
      if (!packet) continue

      const merged = new Uint8Array(readBuffer.length + packet.length)
      merged.set(readBuffer, 0)
      merged.set(packet, readBuffer.length)
      readBuffer = merged

      while (true) {
        const parsed = readLengthPrefixedPacket(readBuffer)
        if (!parsed) break
        readBuffer = parsed.remainder

        if (parsed.payload.length < 12) continue

        let framePayload = parsed.payload
        if (framePayload.length === 12) {
          if (sharedReadInFlight) continue
          sharedReadInFlight = true
          try {
            const expanded = await desktop.media.readSharedFrame(activeSessionId)
            if (!expanded) continue
            framePayload = new Uint8Array(expanded)
          } finally {
            sharedReadInFlight = false
          }
        }

        const view = new DataView(
          framePayload.buffer,
          framePayload.byteOffset,
          framePayload.byteLength,
        )
        const width = view.getUint32(0, true)
        const height = view.getUint32(4, true)
        const stride = view.getUint32(8, true)
        const pixels = framePayload.slice(12)
        const expectedPixels = stride * height
        if (width === 0 || height === 0) continue

        try {
          const frame = new VideoFrame(pixels, {
            format: 'BGRA',
            codedWidth: width,
            codedHeight: height,
            timestamp,
            layout: [{ offset: 0, stride }],
          })
          await writer.write(frame)
          frame.close()
          lastFrameWidth = width
          lastFrameHeight = height
          if (!firstFrameWritten) {
            firstFrameWritten = true
            resolveFirstFrame?.()
            resolveFirstFrame = null
          }
          timestamp += frameDurationUs
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error)
          bridgeError = new Error(message)
          break
        }
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
    if (activeSessionId !== '__pending__') {
      void desktop.media.stopSession(activeSessionId)
    }
  }

  const waitForFirstFrame = (timeoutMs = 10_000) =>
    Promise.race([
      firstFrameReady,
      new Promise<void>((_resolve, reject) => {
        window.setTimeout(
          () => reject(new Error('Native media engine first frame timeout')),
          timeoutMs,
        )
      }),
    ])

  return {
    track: generator,
    bindSession: (nextSessionId: string) => {
      activeSessionId = nextSessionId
    },
    waitForFirstFrame,
    getLastFrameDimensions: () =>
      lastFrameWidth > 0 && lastFrameHeight > 0
        ? { width: lastFrameWidth, height: lastFrameHeight }
        : null,
    stop,
  }
}
