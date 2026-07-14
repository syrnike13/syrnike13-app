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
      }),
    ).toEqual({
      code: 'connect_failed',
      message: 'failed at [redacted-url] token=[redacted]',
      stage: '[redacted-url]',
      retryable: true,
      sessionId: 'session-1',
      generation: 7,
    })
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
      livekit: {
        url: 'wss://voice.example',
        token: 'token',
        participantIdentity: 'participant',
      },
    },
  }

  it('accepts WebSocket LiveKit URLs and bounded Windows identifiers', () => {
    expect(isNativeRuntimeCommand(microphone)).toBe(true)
    expect(
      isNativeRuntimeCommand({
        type: 'listDisplaySources',
        selfWindowHwnd: '18446744073709551615',
      }),
    ).toBe(true)
  })

  it('rejects HTTP LiveKit URLs and overflowing Windows identifiers', () => {
    expect(
      isNativeRuntimeCommand({
        ...microphone,
        options: {
          ...microphone.options,
          livekit: { ...microphone.options.livekit, url: 'https://voice.example' },
        },
      }),
    ).toBe(false)
    expect(
      isNativeRuntimeCommand({ ...microphone, excludeProcessId: -1 }),
    ).toBe(false)
    expect(
      isNativeRuntimeCommand({
        type: 'listDisplaySources',
        selfWindowHwnd: '18446744073709551616',
      }),
    ).toBe(false)
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
})
