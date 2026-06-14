import { describe, expect, it } from 'vitest'

import {
  mapAudioMode,
  mapEncoderBackend,
  mapFrameMethod,
  mapLifecycleState,
  mapLoopbackMode,
  parseSidecarEvent,
} from './native-media-engine-sidecar'

describe('native media engine sidecar protocol', () => {
  it('maps system exclude and none audio modes', () => {
    expect(mapAudioMode('system_exclude')).toBe('system_exclude')
    expect(mapAudioMode('none')).toBe('none')
    expect(mapAudioMode(undefined)).toBe('none')
    expect(mapLoopbackMode('include_target_process_tree')).toBe(
      'include_target_process_tree',
    )
    expect(mapLoopbackMode('exclude_target_process_tree')).toBe(
      'exclude_target_process_tree',
    )
  })

  it('parses ready event with process audio target metadata', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'ready',
        port: 0,
        stream_mode: 'native',
        encoder: 'webrtc',
        audio_mode: 'process',
        audio_target_process_id: 777,
        audio_loopback_mode: 'include_target_process_tree',
      }),
    )

    expect(event?.type).toBe('ready')
    if (event?.type === 'ready') {
      expect(mapEncoderBackend(event.encoder)).toBe('webrtc')
      expect(mapAudioMode(event.audio_mode)).toBe('process')
      expect(event.audio_target_process_id).toBe(777)
      expect(mapLoopbackMode(event.audio_loopback_mode)).toBe(
        'include_target_process_tree',
      )
    }
  })

  it('parses native screen ready event', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'ready',
        port: 0,
        stream_mode: 'native',
        encoder: 'webrtc',
        codec: 'auto-webrtc',
        width: 1920,
        height: 1080,
        fps: 60,
        bitrate: 8_000_000,
        audio_mode: 'process',
        audio_sample_rate: 48_000,
        audio_channels: 2,
        audio_target_process_id: 777,
        audio_loopback_mode: 'include_target_process_tree',
      }),
    )

    expect(event?.type).toBe('ready')
    if (event?.type === 'ready') {
      expect(event.port).toBe(0)
      expect(mapEncoderBackend(event.encoder)).toBe('webrtc')
      expect(event.audio_sample_rate).toBe(48_000)
      expect(event.audio_channels).toBe(2)
      expect(event.audio_target_process_id).toBe(777)
      expect(mapLoopbackMode(event.audio_loopback_mode)).toBe(
        'include_target_process_tree',
      )
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

  it('parses native display source metadata for process-targeted audio', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'display_source_list',
        sources: [
          {
            id: 'game:1234',
            name: 'Example Game',
            type: 'game',
            thumbnailDataUrl: null,
            appIconDataUrl: null,
            processId: 777,
            processPath: 'C:\\Games\\Example\\game.exe',
            classification: 'game_path',
            audioAvailable: true,
            audioMode: 'process',
          },
        ],
      }),
    )

    expect(event?.type).toBe('display_source_list')
    if (event?.type === 'display_source_list') {
      expect(event.sources[0]).toMatchObject({
        id: 'game:1234',
        type: 'game',
        processId: 777,
        classification: 'game_path',
        audioAvailable: true,
        audioMode: 'process',
      })
    }
  })

  it('parses native screen share preflight metrics', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'screen_share_preflight',
        sourceId: 'game:1234',
        source_type: 'game',
        ok: true,
        video: {
          method: 'wgc',
          captured: true,
          width: 1920,
          height: 1080,
          fps: 60,
          duration_ms: 1000,
          attempts: 60,
          captured_frames: 60,
          late_frames: 0,
          avg_capture_us: 5000,
          bytes: 8_294_400,
        },
        audio: {
          requested: true,
          ok: true,
          mode: 'process',
          loopback_mode: 'include_target_process_tree',
          target_process_id: 777,
          peak_db: -6.5,
          rms_db: -18.25,
          sample_rate: 48_000,
          channels: 2,
        },
      }),
    )

    expect(event?.type).toBe('screen_share_preflight')
    if (event?.type === 'screen_share_preflight') {
      expect(event).toMatchObject({
        sourceId: 'game:1234',
        source_type: 'game',
        ok: true,
        video: {
          method: 'wgc',
          width: 1920,
          height: 1080,
          fps: 60,
          captured_frames: 60,
        },
        audio: {
          mode: 'process',
          loopback_mode: 'include_target_process_tree',
          target_process_id: 777,
          peak_db: -6.5,
          rms_db: -18.25,
        },
      })
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

  it('parses screen audio capture failure events', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'error',
        code: 'screen_audio_capture_failed',
        message: 'failed to start screen loopback stream',
      }),
    )

    expect(event).toEqual({
      type: 'error',
      code: 'screen_audio_capture_failed',
      message: 'failed to start screen loopback stream',
    })
  })

  it('parses native screen audio track publish metadata', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'track_published',
        session_id: 'screen-session-1',
        kind: 'audio',
        source: 'screen_share_audio',
        audio_mode: 'process',
        audio_sample_rate: 48_000,
        audio_channels: 2,
        audio_target_process_id: 777,
        audio_loopback_mode: 'include_target_process_tree',
      }),
    )

    expect(event?.type).toBe('track_published')
    if (event?.type === 'track_published') {
      expect(event.kind).toBe('audio')
      expect(mapAudioMode(event.audio_mode)).toBe('process')
      expect(event.audio_target_process_id).toBe(777)
      expect(mapLoopbackMode(event.audio_loopback_mode)).toBe(
        'include_target_process_tree',
      )
    }
  })

  it('parses screen audio frame counters', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'screen_audio_frame',
        session_id: 'screen-session-1',
        frames: 96_000,
        packets: 100,
        peak_db: -6.5,
        rms_db: -18.25,
        sample_rate: 48_000,
        channels: 2,
        audio_mode: 'process',
        audio_target_process_id: 777,
        audio_loopback_mode: 'include_target_process_tree',
      }),
    )

    expect(event?.type).toBe('screen_audio_frame')
    if (event?.type === 'screen_audio_frame') {
      expect(event.frames).toBe(96_000)
      expect(event.packets).toBe(100)
      expect(event.peak_db).toBe(-6.5)
      expect(event.rms_db).toBe(-18.25)
      expect(mapAudioMode(event.audio_mode)).toBe('process')
      expect(mapLoopbackMode(event.audio_loopback_mode)).toBe(
        'include_target_process_tree',
      )
      expect(event.audio_target_process_id).toBe(777)
    }
  })

  it('parses screen video frame counters', () => {
    const event = parseSidecarEvent(
      JSON.stringify({
        type: 'screen_video_frame',
        session_id: 'screen-session-1',
        frames: 120,
        interval_frames: 60,
        target_fps: 60,
        late_frames: 0,
        no_frame_count: 2,
        repeated_frame_count: 3,
        recoverable_lost_count: 1,
        avg_capture_us: 3200,
        avg_readback_us: 1100,
        avg_scale_us: 900,
        avg_publish_us: 700,
        source_width: 2560,
        source_height: 1440,
        content_width: 1920,
        content_height: 1080,
        capture_thread_mmcss: true,
        method: 'wgc',
      }),
    )

    expect(event?.type).toBe('screen_video_frame')
    if (event?.type === 'screen_video_frame') {
      expect(event.frames).toBe(120)
      expect(event.interval_frames).toBe(60)
      expect(event.target_fps).toBe(60)
      expect(event.late_frames).toBe(0)
      expect(event.no_frame_count).toBe(2)
      expect(event.repeated_frame_count).toBe(3)
      expect(event.recoverable_lost_count).toBe(1)
      expect(event.avg_capture_us).toBe(3200)
      expect(event.avg_readback_us).toBe(1100)
      expect(event.avg_scale_us).toBe(900)
      expect(event.avg_publish_us).toBe(700)
      expect(event.source_width).toBe(2560)
      expect(event.source_height).toBe(1440)
      expect(event.content_width).toBe(1920)
      expect(event.content_height).toBe(1080)
      expect(event.capture_thread_mmcss).toBe(true)
      expect(mapFrameMethod(event.method ?? '')).toBe('wgc')
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
        audio_target_process_id: 12345,
        audio_loopback_mode: 'exclude_target_process_tree',
        width: 1920,
        height: 1038,
        fps: 60,
        bitrate: 8_000_000,
      }),
    ).toEqual({
      status: 'running',
      sessionId: 'session-1',
      port: 55123,
      width: 1920,
      height: 1038,
      fps: 60,
      bitrate: 8_000_000,
      audio: {
        mode: 'system_exclude',
        port: 55124,
        targetProcessId: 12345,
        loopbackMode: 'exclude_target_process_tree',
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
        audio_mode: 'microphone',
        audio_sample_rate: 48_000,
        audio_channels: 1,
        noise_suppression: 'software',
        echo_cancellation: 'software',
      }),
    ).toEqual({
      status: 'running',
      sessionId: 'mic-session-1',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
    })
  })

})
