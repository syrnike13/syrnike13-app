import { describe, expect, it } from 'vitest'

import {
  isNativeRuntimeCommand,
  isNativeRuntimeEvent,
  redactSensitiveText,
  sanitizeRuntimeError,
} from './contract'

describe('native runtime error privacy', () => {
  it('redacts tokens, bearer credentials, and room URLs', () => {
    const redacted = redactSensitiveText(
      'connect wss://voice.example/room?access_token=secret token=abc Bearer ey.secret.value',
    )

    expect(redacted).not.toContain('voice.example')
    expect(redacted).not.toContain('secret')
    expect(redacted).not.toContain('token=abc')
    expect(redacted).toContain('[redacted-url]')
    expect(redacted).toContain('token=[redacted]')
    expect(redacted).toContain('Bearer [redacted]')
  })

  it('sanitizes an already typed native error without losing its fence', () => {
    expect(
      sanitizeRuntimeError({
        code: 'connect_failed',
        message: 'failed at https://voice.example/room token=secret',
        stage: 'wss://voice.example/private',
        retryable: true,
        sessionId: 'session-1',
        generation: 7,
        hresult: -2_147_024_895,
      }),
    ).toEqual({
      code: 'connect_failed',
      message: 'failed at [redacted-url] token=[redacted]',
      stage: '[redacted-url]',
      retryable: true,
      sessionId: 'session-1',
      generation: 7,
      hresult: -2_147_024_895,
    })
  })

  it('rejects an unsafe HRESULT in a native event', () => {
    expect(isNativeRuntimeEvent({
      type: 'runtimeError',
      sequence: 1,
      error: {
        code: 'audio_endpoint_failed',
        message: 'Audio endpoint failed',
        retryable: false,
        hresult: Number.MAX_SAFE_INTEGER + 1,
      },
    })).toBe(false)
  })

  it('accepts a generation-fenced microphone fallback lifecycle', () => {
    const event = {
      type: 'sessionLifecycle',
      sequence: 2,
      sessionId: 'voice-session',
      generation: 7,
      kind: 'microphone',
      state: {
        status: 'running',
        sessionId: 'voice-session',
        deviceId: 'default',
        message: 'Selected audio input is unavailable; using system default',
      },
      error: {
        code: 'audio_input_fallback_default',
        message: 'Selected audio input is unavailable; using system default',
        stage: 'configureMicrophoneInput',
        retryable: false,
        sessionId: 'voice-session',
        generation: 7,
      },
    } as const

    expect(isNativeRuntimeEvent(event)).toBe(true)
    expect(isNativeRuntimeEvent({
      ...event,
      state: { ...event.state, deviceId: 42 },
    })).toBe(false)
  })
})

describe('native runtime command validation', () => {
  const microphone = {
    type: 'connectMicrophone' as const,
    sessionId: 'session-1',
    generation: 1,
    excludeProcessId: 42,
    options: {
      kind: 'microphone' as const,
      requestId: 'request-1',
      sampleRate: 48_000 as const,
      channels: 1 as const,
      noiseSuppression: true,
      echoCancellation: true,
      inputVolume: 1,
      participantIdentity: 'participant',
    },
  }

  it('accepts credentials only on connectVoice and requires a WebSocket URL', () => {
    const connectVoice = {
      type: 'connectVoice' as const,
      sessionId: 'voice-session',
      generation: 1,
      options: {
        livekit: {
          url: 'wss://voice.example',
          token: 'token',
          participantIdentity: 'participant',
        },
      },
    }

    expect(isNativeRuntimeCommand(connectVoice)).toBe(true)
    expect(isNativeRuntimeCommand({
      ...connectVoice,
      options: {
        livekit: { ...connectVoice.options.livekit, url: 'https://voice.example' },
      },
    })).toBe(false)
  })

  it('accepts track publication identity and bounded Windows identifiers', () => {
    expect(isNativeRuntimeCommand(microphone)).toBe(true)
    expect(
      isNativeRuntimeCommand({
        type: 'listDisplaySources',
        selfWindowHwnd: '18446744073709551615',
      }),
    ).toBe(true)
  })

  it('rejects missing track publication identity and overflowing Windows identifiers', () => {
    expect(
      isNativeRuntimeCommand({
        ...microphone,
        options: { ...microphone.options, participantIdentity: '' },
      }),
    ).toBe(false)
    expect(
      isNativeRuntimeCommand({ ...microphone, excludeProcessId: -1 }),
    ).toBe(false)
    expect(isNativeRuntimeCommand({
      ...microphone,
      options: {
        ...microphone.options,
        livekit: {
          url: 'wss://voice.example',
          token: 'must-not-cross-track-interface',
          participantIdentity: 'participant',
        },
      },
    })).toBe(false)
    expect(
      isNativeRuntimeCommand({
        type: 'listDisplaySources',
        selfWindowHwnd: '18446744073709551616',
      }),
    ).toBe(false)
  })

  it('requires RAW bypass and AGC flags in microphone pipeline commands', () => {
    const command = {
      type: 'configureMicrophone',
      revision: 2,
      config: {
        deviceId: null,
        bypassSystemAudioInputProcessing: true,
        automaticGainControl: false,
        noiseSuppression: true,
        echoCancellation: true,
        inputVolume: 1,
        voiceGateEnabled: true,
        voiceGateThresholdDb: -28,
        voiceGateAutoThreshold: true,
      },
    }

    expect(isNativeRuntimeCommand(command)).toBe(true)
    const { automaticGainControl: _automaticGainControl, ...incomplete } =
      command.config
    expect(isNativeRuntimeCommand({ ...command, config: incomplete })).toBe(false)
  })

  it('accepts bounded local screen preview demand and release commands', () => {
    expect(isNativeRuntimeCommand({
      type: 'setLocalScreenPreviewDemand',
      sessionId: 'screen-session',
      generation: 3,
      demanded: true,
      electronMainPid: 42,
      options: { width: 1920, height: 1080, fps: 30 },
    })).toBe(true)
    expect(isNativeRuntimeCommand({
      type: 'setLocalScreenPreviewDemand',
      sessionId: 'screen-session',
      generation: 3,
      demanded: true,
      electronMainPid: 42,
      options: { width: 1920, height: 1080, fps: 60 },
    })).toBe(true)
    expect(isNativeRuntimeCommand({
      type: 'setLocalScreenPreviewDemand',
      sessionId: 'screen-session',
      generation: 3,
      demanded: true,
      electronMainPid: 42,
      options: { width: 1920, height: 1080, fps: 61 },
    })).toBe(false)
    expect(isNativeRuntimeCommand({
      type: 'releaseLocalScreenPreviewFrame',
      sessionId: 'screen-session',
      generation: 3,
      trackId: 'local-screen:screen-session',
      sequence: 7,
    })).toBe(true)
  })

  it('accepts a retryable local preview diagnostic without failing the screen session', () => {
    expect(isNativeRuntimeEvent({
      type: 'localScreenPreviewFailed',
      sequence: 7,
      sessionId: 'screen-session',
      generation: 3,
      trackId: 'local-screen:screen-session',
      error: {
        code: 'LOCAL_SCREEN_PREVIEW_FAILED',
        message: 'failed to create preview output view (HRESULT -2147024809)',
        stage: 'gpu_interop_unavailable',
        retryable: true,
        sessionId: 'screen-session',
        generation: 3,
      },
    })).toBe(true)
  })

  it('requires the screen source when the local preview track is removed', () => {
    const removed = {
      type: 'localScreenPreviewTrackRemoved',
      sequence: 8,
      sessionId: 'screen-session',
      generation: 3,
      trackId: 'local-screen:screen-session',
    }

    expect(isNativeRuntimeEvent({ ...removed, source: 'screen' })).toBe(true)
    expect(isNativeRuntimeEvent(removed)).toBe(false)
  })

  it('validates local camera preview frames, releases, failures, and removal', () => {
    expect(isNativeRuntimeCommand({
      type: 'releaseLocalCameraPreviewFrame',
      sessionId: 'voice-session',
      generation: 5,
      trackId: 'camera-publication',
      sequence: 12,
    })).toBe(true)

    expect(isNativeRuntimeEvent({
      type: 'localCameraPreviewFrame',
      sequence: 9,
      sessionId: 'voice-session',
      generation: 5,
      trackId: 'camera-publication',
      participantIdentity: 'user:native-camera',
      source: 'camera',
      frameSequence: 12,
      timestampUs: 33_000,
      width: 1280,
      height: 720,
      ntHandle: new Uint8Array(8),
    })).toBe(true)

    expect(isNativeRuntimeEvent({
      type: 'localCameraPreviewTrackRemoved',
      sequence: 10,
      sessionId: 'voice-session',
      generation: 5,
      trackId: 'camera-publication',
      source: 'camera',
    })).toBe(true)

    expect(isNativeRuntimeEvent({
      type: 'localCameraPreviewFailed',
      sequence: 11,
      sessionId: 'voice-session',
      generation: 5,
      trackId: 'camera-publication',
      error: {
        code: 'LOCAL_CAMERA_PREVIEW_FAILED',
        message: 'Local camera preview stream ended unexpectedly',
        stage: 'local_camera_preview',
        retryable: false,
        sessionId: 'voice-session',
        generation: 5,
      },
    })).toBe(true)
  })

  it('validates remote screen publication inventory events', () => {
    const publication = {
      sequence: 9,
      sessionId: 'voice-session',
      generation: 4,
      trackId: 'screen-publication',
      participantIdentity: 'user:screen',
      source: 'screen',
    }

    expect(isNativeRuntimeEvent({
      ...publication,
      type: 'remoteScreenPublicationAvailable',
    })).toBe(true)
    expect(isNativeRuntimeEvent({
      ...publication,
      type: 'remoteScreenPublicationUnavailable',
    })).toBe(true)
    expect(isNativeRuntimeEvent({
      ...publication,
      type: 'remoteScreenPublicationAvailable',
      participantIdentity: '',
    })).toBe(false)
  })
})
