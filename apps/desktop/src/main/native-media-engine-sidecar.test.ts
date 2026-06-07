import { describe, expect, it } from 'vitest'

import {
  isSharedFrameSignal,
  mapAudioMode,
  mapEncoderBackend,
  mapFrameMethod,
  mapLifecycleState,
  mapStreamMode,
  parseBgraFrameHeader,
  parseSidecarEvent,
} from './native-media-engine-sidecar'

describe('native media engine sidecar protocol', () => {
  it('maps system exclude and none audio modes', () => {
    expect(mapAudioMode('system_exclude')).toBe('system_exclude')
    expect(mapAudioMode('none')).toBe('none')
    expect(mapAudioMode(undefined)).toBe('none')
  })

  it('parses ready event with process audio port', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'ready',
        port: 55123,
        stream_mode: 'bgra',
        encoder: 'media_foundation',
        audio_port: 55124,
        audio_mode: 'process',
      }),
    )

    expect(event?.type).toBe('ready')
    if (event?.type === 'ready') {
      expect(event.audio_port).toBe(55124)
      expect(mapAudioMode(event.audio_mode)).toBe('process')
    }
  })

  it('parses ready event with shared frame buffer path', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'ready',
        port: 55123,
        stream_mode: 'bgra',
        encoder: 'media_foundation',
        frame_buffer_path: 'C:\\Temp\\syrnike-capture-1.bin',
      }),
    )

    expect(event?.type).toBe('ready')
    if (event?.type === 'ready') {
      expect(event.port).toBe(55123)
      expect(mapStreamMode(event.stream_mode)).toBe('bgra')
      expect(mapEncoderBackend(event.encoder)).toBe('media_foundation')
      expect(event.frame_buffer_path).toContain('syrnike-capture')
    }
  })

  it('parses native audio input device list events', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'device_list',
        devices: [
          {
            deviceId: '{0.0.1.00000000}.native-mic',
            kind: 'audioinput',
            label: 'Native microphone',
          },
        ],
      }),
    )

    expect(event?.type).toBe('device_list')
    if (event?.type === 'device_list') {
      expect(event.devices).toEqual([
        {
          deviceId: '{0.0.1.00000000}.native-mic',
          kind: 'audioinput',
          label: 'Native microphone',
        },
      ])
    }
  })

  it('parses frame method stats', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'frame_method',
        method: 'wgc',
        count: 42,
        active_method: 'wgc',
      }),
    )

    expect(event?.type).toBe('frame_method')
    if (event?.type === 'frame_method') {
      expect(mapFrameMethod(event.method)).toBe('wgc')
      expect(mapFrameMethod(event.active_method ?? '')).toBe('wgc')
      expect(event.count).toBe(42)
    }
  })

  it('parses session lifecycle events', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'session_lifecycle',
        session_id: 'session-1',
        kind: 'screen',
        status: 'running',
        port: 55123,
      }),
    )

    expect(event?.type).toBe('session_lifecycle')
    if (event?.type === 'session_lifecycle') {
      expect(event.session_id).toBe('session-1')
      expect(event.kind).toBe('screen')
      expect(event.status).toBe('running')
      expect(event.port).toBe(55123)
    }
  })

  it('maps session lifecycle events to desktop media state', () => {
    expect(
      mapLifecycleState({
        type: 'session_lifecycle',
        session_id: 'session-1',
        kind: 'screen',
        status: 'running',
        port: 55123,
      }),
    ).toEqual({
      status: 'running',
      sessionId: 'session-1',
      port: 55123,
    })
  })

  it('maps session lifecycle audio to desktop media state', () => {
    expect(
      mapLifecycleState({
        type: 'session_lifecycle',
        session_id: 'session-1',
        kind: 'screen',
        status: 'running',
        port: 55123,
        audio_port: 55124,
        audio_mode: 'system_exclude',
      }),
    ).toEqual({
      status: 'running',
      sessionId: 'session-1',
      port: 55123,
      audio: {
        mode: 'system_exclude',
        port: 55124,
      },
    })
  })

  it('maps microphone lifecycle audio to desktop media state', () => {
    expect(
      mapLifecycleState({
        type: 'session_lifecycle',
        session_id: 'mic-session-1',
        kind: 'microphone',
        status: 'running',
        audio_port: 55200,
        audio_mode: 'microphone',
        audio_sample_rate: 48_000,
        audio_channels: 1,
      }),
    ).toEqual({
      status: 'running',
      sessionId: 'mic-session-1',
      audio: {
        mode: 'microphone',
        port: 55200,
        sampleRate: 48_000,
        channels: 1,
      },
    })
  })

  it('detects shared frame signal packets', () => {
    expect(isSharedFrameSignal(12, 'bgra')).toBe(true)
    expect(isSharedFrameSignal(1024, 'bgra')).toBe(false)
    expect(isSharedFrameSignal(12, 'h264')).toBe(false)
  })

  it('parses bgra frame headers', () => {
    const header = Buffer.alloc(12)
    header.writeUInt32LE(1920, 0)
    header.writeUInt32LE(1080, 4)
    header.writeUInt32LE(7680, 8)

    expect(parseBgraFrameHeader(header)).toEqual({
      width: 1920,
      height: 1080,
      stride: 7680,
    })
  })
})
