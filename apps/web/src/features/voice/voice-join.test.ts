import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createVoiceJoinRunner,
  nativeCredentialsFromJoinResponse,
  voiceJoinErrorMessage,
} from './voice-join'
import { syncStore } from '#/features/sync/sync-store'
import { requestVoiceJoin } from '#/features/voice/voice-gateway'

vi.mock('livekit-client', () => ({
  Room: vi.fn(function Room() {
    return {
      connect: vi.fn(async () => {}),
    }
  }),
}))

vi.mock('#/features/voice/voice-gateway', () => ({
  requestVoiceJoin: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

vi.mock('#/features/voice/voice-preference-store', () => ({
  readVoicePreferences: () => ({
    micEnabled: true,
    deafened: false,
  }),
}))

vi.mock('#/features/voice/voice-capture', () => ({
  createVoiceRoomOptions: () => ({}),
}))

beforeEach(() => {
  vi.clearAllMocks()
  syncStore.reset()
  syncStore.upsertChannel({
    _id: 'channel-1',
    channel_type: 'VoiceChannel',
    server: 'server-1',
  } as never)
  vi.mocked(requestVoiceJoin).mockResolvedValue({
    type: 'VoiceServerUpdate',
    channel_id: 'channel-1',
    node: 'node-1',
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
  })
})

describe('voiceJoinErrorMessage', () => {
  it('uses error message when available', () => {
    expect(voiceJoinErrorMessage(new Error('Voice join timed out'))).toBe(
      'Voice join timed out',
    )
  })

  it('falls back to generic message', () => {
    expect(voiceJoinErrorMessage('boom')).toBe(
      'Не удалось подключиться к голосу',
    )
  })
})

describe('createVoiceJoinRunner', () => {
  it('reports concrete phases while joining voice', async () => {
    const phases: string[] = []
    const runner = createVoiceJoinRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      setJoinBlockedUntil: vi.fn(),
      shouldLeaveBeforeJoin: () => false,
      leaveBeforeJoin: vi.fn(),
      beginConnecting: vi.fn(),
      setActiveRoom: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: (phase) => phases.push(phase),
    })

    await runner('channel-1')

    expect(phases).toEqual([
      'joining_channel',
      'fetching_rtc_token',
      'connecting_rtc',
      'connecting_microphone',
    ])
    expect(requestVoiceJoin).toHaveBeenCalledWith('channel-1', false, false)
  })

  it('does not suppress an immediate user join retry for the same channel', async () => {
    syncStore.upsertChannel({
      _id: 'channel-repeat',
      channel_type: 'VoiceChannel',
      server: 'server-1',
    } as never)
    const runner = createVoiceJoinRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      setJoinBlockedUntil: vi.fn(),
      shouldLeaveBeforeJoin: () => false,
      leaveBeforeJoin: vi.fn(),
      beginConnecting: vi.fn(),
      setActiveRoom: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expect(runner('channel-repeat')).resolves.toBe(true)
    await expect(runner('channel-repeat')).resolves.toBe(true)

    expect(requestVoiceJoin).toHaveBeenCalledTimes(2)
  })
})

describe('nativeCredentialsFromJoinResponse', () => {
  it('keeps native microphone, screen, and camera publishers on separate identities', () => {
    const response = {
      type: 'VoiceServerUpdate' as const,
      channel_id: 'channel-1',
      node: 'node-1',
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
