import { describe, expect, it } from 'vitest'
import type { CreateVoiceUserResponse } from '@syrnike13/api-types'

import {
  nativeCredentialsFromJoinResponse,
  voiceJoinErrorMessage,
} from './voice-join'
import { ApiError } from '#/lib/api/client'

describe('voiceJoinErrorMessage', () => {
  it('maps rate limit errors', () => {
    expect(voiceJoinErrorMessage(new ApiError('rate', 429))).toContain(
      'Слишком много запросов',
    )
  })

  it('maps unavailable channel errors', () => {
    expect(voiceJoinErrorMessage(new ApiError('bad', 400))).toBe(
      'Голос недоступен в этом канале',
    )
  })

  it('falls back to generic message', () => {
    expect(voiceJoinErrorMessage('boom')).toBe(
      'Не удалось подключиться к голосу',
    )
  })
})

describe('nativeCredentialsFromJoinResponse', () => {
  it('keeps native microphone, screen, and camera publishers on separate identities', () => {
    const response: CreateVoiceUserResponse = {
      token: 'browser-token',
      url: 'wss://livekit.example',
      native_microphone: {
        token: 'mic-token',
        identity: 'user-1:desktop-native:microphone',
      },
      native_screen: {
        token: 'screen-token',
        identity: 'user-1:desktop-native:screen',
      },
      native_camera: {
        token: 'camera-token',
        identity: 'user-1:desktop-native:camera',
      },
    }

    expect(nativeCredentialsFromJoinResponse(response)).toEqual({
      microphone: {
        url: 'wss://livekit.example',
        token: 'mic-token',
        participantIdentity: 'user-1:desktop-native:microphone',
      },
      screen: {
        url: 'wss://livekit.example',
        token: 'screen-token',
        participantIdentity: 'user-1:desktop-native:screen',
      },
      camera: {
        url: 'wss://livekit.example',
        token: 'camera-token',
        participantIdentity: 'user-1:desktop-native:camera',
      },
    })
  })
})
