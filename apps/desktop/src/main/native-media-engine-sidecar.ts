import fs from 'node:fs'
import { open } from 'node:fs/promises'

import type {
  NativeMediaAudioMode,
  NativeMediaDeviceInfo,
  NativeMediaEncoderBackend,
  NativeMediaFrameMethod,
  NativeMediaStateEvent,
  NativeMediaStreamMode,
} from '@syrnike13/platform'

export type SidecarEvent =
  | {
      type: 'ready'
      port: number
      stream_mode?: string
      encoder?: string
      frame_buffer_path?: string
      audio_port?: number
      audio_mode?: string
      audio_sample_rate?: number
      audio_channels?: number
    }
  | {
      type: 'frame_method'
      method: string
      count: number
      active_method?: string
    }
  | { type: 'downgrade'; from: string; to: string; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'stopped' }
  | {
      type: 'device_list'
      devices: NativeMediaDeviceInfo[]
    }
  | {
      type: 'session_lifecycle'
      session_id: string
      kind: 'screen' | 'microphone'
      status: 'starting' | 'running' | 'stopped' | 'error'
      port?: number
      audio_port?: number
      audio_mode?: string
      audio_sample_rate?: number
      audio_channels?: number
      message?: string
    }

export function parseSidecarEvent(line: string): SidecarEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const event = JSON.parse(trimmed) as SidecarEvent
    if (!event || typeof event !== 'object' || !('type' in event)) return null
    return event
  } catch {
    return null
  }
}

export function mapFrameMethod(method: string): NativeMediaFrameMethod | null {
  switch (method) {
    case 'wgc':
      return 'wgc'
    case 'dxgi':
      return 'dxgi'
    case 'gdi_blt':
      return 'gdi_blt'
    case 'gdi_print':
      return 'gdi_print'
    default:
      return null
  }
}

export function mapStreamMode(value: string | undefined): NativeMediaStreamMode {
  return value === 'bgra' ? 'bgra' : 'h264'
}

export function mapEncoderBackend(
  value: string | undefined,
): NativeMediaEncoderBackend {
  return value === 'media_foundation' ? 'media_foundation' : 'openh264'
}

export function mapAudioMode(value: string | undefined): NativeMediaAudioMode {
  if (value === 'process') return 'process'
  if (value === 'system_exclude') return 'system_exclude'
  if (value === 'microphone') return 'microphone'
  return 'none'
}

export function mapLifecycleState(
  event: Extract<SidecarEvent, { type: 'session_lifecycle' }>,
): NativeMediaStateEvent {
  switch (event.status) {
    case 'starting':
      return { status: 'starting', sessionId: event.session_id }
    case 'running':
      return {
        status: 'running',
        sessionId: event.session_id,
        port: event.port,
        audio:
          event.audio_mode || event.audio_port != null
            ? {
                mode: mapAudioMode(event.audio_mode),
                port: event.audio_port,
                sampleRate:
                  event.audio_sample_rate === 48_000 ? 48_000 : undefined,
                channels:
                  event.audio_channels === 1 || event.audio_channels === 2
                    ? event.audio_channels
                    : undefined,
              }
            : undefined,
      }
    case 'error':
      return {
        status: 'error',
        sessionId: event.session_id,
        message: event.message ?? 'Native media engine session failed',
      }
    case 'stopped':
      return { status: 'idle', sessionId: event.session_id }
  }
}

export type BgraFrameHeader = {
  width: number
  height: number
  stride: number
}

export function parseBgraFrameHeader(buffer: Buffer): BgraFrameHeader | null {
  if (buffer.length < 12) return null
  const width = buffer.readUInt32LE(0)
  const height = buffer.readUInt32LE(4)
  const stride = buffer.readUInt32LE(8)
  if (width === 0 || height === 0) return null
  return { width, height, stride }
}

export function readBgraFramePacket(frameBufferPath: string): Buffer {
  const headerBuf = Buffer.alloc(12)
  const fd = fs.openSync(frameBufferPath, 'r')
  try {
    fs.readSync(fd, headerBuf, 0, 12, 0)
    const header = parseBgraFrameHeader(headerBuf)
    if (!header) {
      throw new Error('Invalid shared frame buffer header')
    }
    const pixelBytes = header.width * header.height * 4
    const pixels = Buffer.alloc(pixelBytes)
    fs.readSync(fd, pixels, 0, pixelBytes, 12)
    return Buffer.concat([headerBuf, pixels])
  } finally {
    fs.closeSync(fd)
  }
}

export async function readBgraFramePacketAsync(
  frameBufferPath: string,
): Promise<Buffer> {
  const handle = await open(frameBufferPath, 'r')
  try {
    const headerBuf = Buffer.alloc(12)
    await handle.read(headerBuf, 0, 12, 0)
    const header = parseBgraFrameHeader(headerBuf)
    if (!header) {
      throw new Error('Invalid shared frame buffer header')
    }
    const pixelBytes = header.width * header.height * 4
    const pixels = Buffer.alloc(pixelBytes)
    await handle.read(pixels, 0, pixelBytes, 12)
    return Buffer.concat([headerBuf, pixels])
  } finally {
    await handle.close()
  }
}

export function isSharedFrameSignal(length: number, streamMode: NativeMediaStreamMode) {
  return streamMode === 'bgra' && length === 12
}
