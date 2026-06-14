import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
      disconnect: vi.fn(async () => {}),
      removeAllListeners: vi.fn(),
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
    operation_id: 'op-join',
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
  it('detaches replaced room handlers before disconnecting during handoff', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(providerSource).toMatch(
      /disconnectReplacedVoiceRoom[\s\S]*room\.removeAllListeners\(\)[\s\S]*await room\.disconnect\(\)\.catch\(\(\) => \{\}\)/,
    )
  })

  it('ignores stale room disconnect events after a newer room is active', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(providerSource).toMatch(
      /room\.on\(RoomEvent\.Disconnected[\s\S]*if \(roomRef\.current !== room\) \{[\s\S]*room\.removeAllListeners\(\)[\s\S]*return[\s\S]*\}[\s\S]*const intent = disconnectIntentRef\.current/,
    )
  })

  it('cleans up voice silently on provider unmount instead of playing a manual leave sound', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(providerSource).toMatch(
      /return \(\) => \{[\s\S]*void leaveVoiceSessionRef\.current\('cleanup'\)/,
    )
    expect(providerSource).toMatch(
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*leaveVoiceSessionRef\.current\('cleanup'\)[\s\S]*\}[\s\S]*\}, \[\]\)/,
    )
  })

  it('reports concrete phases while joining voice', async () => {
    const phases: string[] = []
    const requestJoinOperation = vi.fn(() => 'op-join')
    const handleServerPrepareSucceeded = vi.fn()
    const handleRoomConnected = vi.fn()
    const runner = createVoiceJoinRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      setJoinBlockedUntil: vi.fn(),
      getActiveSession: () => null,
      requestJoinOperation,
      handleServerPrepareSucceeded,
      handleRoomConnected,
      handleRoomConnectFailed: vi.fn(),
      beginConnecting: vi.fn(),
      setActiveRoom: vi.fn(),
      disconnectReplacedRoom: vi.fn(),
      restorePreviousSession: vi.fn(),
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
    expect(requestVoiceJoin).toHaveBeenCalledWith(
      'channel-1',
      false,
      false,
      { operationId: 'op-join' },
    )
    expect(requestJoinOperation).toHaveBeenCalledWith(
      'channel-1',
      'manual_join',
    )
    expect(handleServerPrepareSucceeded).toHaveBeenCalledWith('op-join')
    expect(handleRoomConnected).toHaveBeenCalledWith('op-join')
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
      getActiveSession: () => null,
      requestJoinOperation: vi.fn(() => 'op-join'),
      handleServerPrepareSucceeded: vi.fn(),
      handleRoomConnected: vi.fn(),
      handleRoomConnectFailed: vi.fn(),
      beginConnecting: vi.fn(),
      setActiveRoom: vi.fn(),
      disconnectReplacedRoom: vi.fn(),
      restorePreviousSession: vi.fn(),
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

  it('keeps the current voice session alive until the replacement room connects', async () => {
    const previousRoom = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      removeAllListeners: vi.fn(),
    } as never
    const disconnectReplacedRoom = vi.fn(async () => {})
    const runner = createVoiceJoinRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      setJoinBlockedUntil: vi.fn(),
      getActiveSession: () => ({
        room: previousRoom,
        channelId: 'old-channel',
        localVoiceReady: true,
      }),
      requestJoinOperation: vi.fn(() => 'op-join'),
      handleServerPrepareSucceeded: vi.fn(),
      handleRoomConnected: vi.fn(),
      handleRoomConnectFailed: vi.fn(),
      beginConnecting: vi.fn(),
      setActiveRoom: vi.fn(),
      disconnectReplacedRoom,
      restorePreviousSession: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expect(runner('channel-1')).resolves.toBe(true)

    expect(disconnectReplacedRoom).toHaveBeenCalledWith(previousRoom)
  })

  it('passes DM recipients to the voice join request', async () => {
    syncStore.upsertChannel({
      _id: 'dm-channel',
      channel_type: 'DirectMessage',
      active: true,
      recipients: ['user-1', 'user-2'],
      voice: { max_users: null },
    } as never)
    const runner = createVoiceJoinRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      setJoinBlockedUntil: vi.fn(),
      getActiveSession: () => null,
      requestJoinOperation: vi.fn(() => 'op-join'),
      handleServerPrepareSucceeded: vi.fn(),
      handleRoomConnected: vi.fn(),
      handleRoomConnectFailed: vi.fn(),
      beginConnecting: vi.fn(),
      setActiveRoom: vi.fn(),
      disconnectReplacedRoom: vi.fn(),
      restorePreviousSession: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expect(runner('dm-channel')).resolves.toBe(true)

    expect(requestVoiceJoin).toHaveBeenCalledWith(
      'dm-channel',
      false,
      false,
      {
        operationId: 'op-join',
        recipients: ['user-2'],
      },
    )
  })

  it('does not pass DM recipients during rejoin', async () => {
    syncStore.upsertChannel({
      _id: 'dm-channel',
      channel_type: 'DirectMessage',
      active: true,
      recipients: ['user-1', 'user-2'],
      voice: { max_users: null },
    } as never)
    const runner = createVoiceJoinRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      setJoinBlockedUntil: vi.fn(),
      getActiveSession: () => null,
      requestJoinOperation: vi.fn(() => 'op-join'),
      handleServerPrepareSucceeded: vi.fn(),
      handleRoomConnected: vi.fn(),
      handleRoomConnectFailed: vi.fn(),
      beginConnecting: vi.fn(),
      setActiveRoom: vi.fn(),
      disconnectReplacedRoom: vi.fn(),
      restorePreviousSession: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expect(runner('dm-channel', { rejoin: true })).resolves.toBe(true)

    expect(requestVoiceJoin).toHaveBeenCalledWith(
      'dm-channel',
      false,
      false,
      {
        operationId: 'op-join',
        suppress_call_notifications: true,
      },
    )
  })

  it('passes group recipients to the voice join request', async () => {
    syncStore.upsertChannel({
      _id: 'group-channel',
      channel_type: 'Group',
      active: true,
      name: 'Команда',
      owner: 'user-1',
      description: null,
      recipients: ['user-1', 'user-2', 'user-3'],
      icon: null,
      last_message_id: null,
      permissions: null,
      nsfw: false,
    } as never)
    const runner = createVoiceJoinRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      setJoinBlockedUntil: vi.fn(),
      getActiveSession: () => null,
      requestJoinOperation: vi.fn(() => 'op-join'),
      handleServerPrepareSucceeded: vi.fn(),
      handleRoomConnected: vi.fn(),
      handleRoomConnectFailed: vi.fn(),
      beginConnecting: vi.fn(),
      setActiveRoom: vi.fn(),
      disconnectReplacedRoom: vi.fn(),
      restorePreviousSession: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expect(runner('group-channel')).resolves.toBe(true)

    expect(requestVoiceJoin).toHaveBeenCalledWith(
      'group-channel',
      false,
      false,
      {
        operationId: 'op-join',
        recipients: ['user-2', 'user-3'],
      },
    )
  })
})

describe('nativeCredentialsFromJoinResponse', () => {
  it('keeps native microphone, screen, and camera publishers on separate identities', () => {
    const response = {
      type: 'VoiceServerUpdate' as const,
      operation_id: 'op-join',
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
