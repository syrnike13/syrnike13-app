import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createVoiceJoinRunner,
  nativeCredentialsFromJoinResponse,
  type VoiceJoinRunnerDeps,
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
      identity: 'user-1:desktop-native:op-join:microphone',
    },
    native_screen: {
      token: 'screen-token',
      identity: 'user-1:desktop-native:op-join:screen',
    },
    native_camera: {
      token: 'camera-token',
      identity: 'user-1:desktop-native:op-join:camera',
    },
  })
})

async function expectSuccessfulJoin(
  promise: Promise<unknown>,
): Promise<{ room: unknown }> {
  const result = await promise
  expect(result).toMatchObject({
    room: expect.objectContaining({
      connect: expect.any(Function),
      disconnect: expect.any(Function),
      removeAllListeners: expect.any(Function),
    }),
  })
  return result as { room: unknown }
}

function createRunner(deps: VoiceJoinRunnerDeps) {
  return createVoiceJoinRunner({ getDeps: () => deps })
}

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
  it('detaches replaced source rooms through VoiceIntentExecutor', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(providerSource).toMatch(
      /disconnectMoveSource: async \(\{ room, channelId \}\) => \{[\s\S]*room\.removeAllListeners\(\)[\s\S]*await room\.disconnect\(\)\.catch/,
    )
    expect(providerSource).not.toContain('finalizePendingVoiceMove')
  })

  it('ignores stale room disconnect events after a newer room is active', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const roomAudioSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-room-audio.ts'),
      'utf8',
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(roomAudioSource).toMatch(
      /room\.on\(RoomEvent\.Disconnected[\s\S]*if \(deps\.getCurrentRoom\(\) !== room\) \{[\s\S]*room\.removeAllListeners\(\)[\s\S]*return[\s\S]*\}[\s\S]*deps\.onUnexpectedRoomDisconnect\(targetChannelId\)/,
    )
    expect(roomAudioSource).not.toContain('getDisconnectIntent')
    expect(providerSource).toMatch(
      /onUnexpectedRoomDisconnect[\s\S]*voiceIntentExecutorRef\.current\.onRoomDisconnected\(\s*false,\s*'Room disconnected',?\s*\)/,
    )
    expect(providerSource).not.toContain('voiceRejoinRef')
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
      /return \(\) => \{[\s\S]*void voiceIntentExecutorRef\.current\.disconnectLocalSession\(\)/,
    )
    expect(providerSource).toMatch(
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*voiceIntentExecutorRef\.current\.disconnectLocalSession\(\)[\s\S]*\}[\s\S]*\}, \[\]\)/,
    )
  })

  it('reports concrete phases while joining voice', async () => {
    const phases: string[] = []
    const setActiveRoom = vi.fn()
    const runner = createRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      beginConnecting: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: (phase) => phases.push(phase),
    })

    const result = await expectSuccessfulJoin(
      runner('channel-1', { operationId: 'op-join' }),
    )

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
    expect(setActiveRoom).not.toHaveBeenCalled()
    expect(result.room).toBeTruthy()
  })

  it('does not suppress an immediate user join retry for the same channel', async () => {
    syncStore.upsertChannel({
      _id: 'channel-repeat',
      channel_type: 'VoiceChannel',
      server: 'server-1',
    } as never)
    const runner = createRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      beginConnecting: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expectSuccessfulJoin(
      runner('channel-repeat', { operationId: 'op-join-1' }),
    )
    await expectSuccessfulJoin(
      runner('channel-repeat', { operationId: 'op-join-2' }),
    )

    expect(requestVoiceJoin).toHaveBeenCalledTimes(2)
  })

  it('allows an immediate retry after a failed manual join when the rate window allows it', async () => {
    vi.mocked(requestVoiceJoin).mockRejectedValueOnce(new Error('rtc failed'))
    const runner = createRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      beginConnecting: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expect(
      runner('channel-1', { operationId: 'op-join-failed' }),
    ).resolves.toBe(false)
    await expectSuccessfulJoin(
      runner('channel-1', { operationId: 'op-join-retry' }),
    )
    expect(requestVoiceJoin).toHaveBeenCalledTimes(2)
  })

  it('leaves move source handoff to VoiceIntentExecutor', async () => {
    const previousRoom = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      removeAllListeners: vi.fn(),
    }
    const runner = createRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      beginConnecting: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expectSuccessfulJoin(
      runner('channel-1', { operationId: 'op-join' }),
    )

    expect(previousRoom.removeAllListeners).not.toHaveBeenCalled()
    expect(previousRoom.disconnect).not.toHaveBeenCalled()
  })

  it('does not drop the previous voice session when a move fails before the target connects', async () => {
    vi.mocked(requestVoiceJoin).mockRejectedValueOnce(new Error('rtc failed'))
    const runner = createRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      beginConnecting: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expect(
      runner('channel-1', { operationId: 'op-join' }),
    ).resolves.toBe(false)

  })

  it('provider routes move source handoff through VoiceIntentExecutor', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(providerSource).toMatch(
      /disconnectMoveSource: async \(\{ room, channelId \}\) => \{[\s\S]*room\.removeAllListeners\(\)[\s\S]*await room\.disconnect\(\)\.catch/,
    )
    expect(providerSource).not.toMatch(
      /disconnectMoveSource: async \(\{ room, channelId \}\) => \{[\s\S]*disconnectNativeMediaForHandoff\(\)/,
    )
    expect(providerSource).not.toMatch(
      /voiceIntentExecutorRef\.current\.observeCommit\(action\.operationId, action\.channelId\)[\s\S]*finalizePendingVoiceMove\(action\.operationId\)/,
    )
  })

  it('provider no longer stores pending move sources outside the executor', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(providerSource).not.toContain('pendingReplacedVoiceRoomRef')
    expect(providerSource).not.toContain('disconnectReplacedVoiceSession')
  })

  it('provider lets VoiceIntentExecutor restore pending move sources', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(providerSource).not.toContain('restorePendingVoiceMoveToSource')
    expect(providerSource).not.toContain('restorePreviousSession')
    expect(providerSource).toMatch(
      /voiceIntentExecutorRef\.current\.intent\(targetChannelId, reason\)/,
    )
  })

  it('provider terminal leave delegates pending source cleanup to VoiceIntentExecutor', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(providerSource).not.toContain('disconnectPendingReplacedVoiceRoom')
    expect(providerSource).toMatch(
      /completeTerminalLeave: async \(\{ channelId: leftChannelId, room \}\) => \{[\s\S]*if \(room\) \{/,
    )
  })

  it('provider lets a newer move supersede an in-flight move to another channel', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(providerSource).not.toMatch(
      /if \(inFlight\) \{[\s\S]*await inFlight\.promise\.catch/,
    )
    expect(providerSource).toMatch(/isCurrentJoinOperation/)
    expect(providerSource).not.toContain('disconnectSupersededTargetRoom')
    expect(providerSource).toMatch(/previousVisualChannelId/)
    expect(providerSource).not.toContain('pendingReplacedVoiceRoomRef')
    expect(providerSource).not.toContain('controllerState.previousChannelId')
    expect(providerSource).not.toContain('rememberVoiceIntentCanceledOperation')
    expect(providerSource).toMatch(
      /voiceIntentExecutorRef\.current\.intent\(targetChannelId, reason\)/,
    )
  })

  it('passes DM recipients to the voice join request', async () => {
    syncStore.upsertChannel({
      _id: 'dm-channel',
      channel_type: 'DirectMessage',
      active: true,
      recipients: ['user-1', 'user-2'],
      voice: { max_users: null },
    } as never)
    const runner = createRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      beginConnecting: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expectSuccessfulJoin(
      runner('dm-channel', { operationId: 'op-join' }),
    )

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
    const runner = createRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      beginConnecting: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expectSuccessfulJoin(
      runner('dm-channel', { operationId: 'op-join', rejoin: true }),
    )

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
    const runner = createRunner({
      getToken: () => 'session-token',
      getLocalUserId: () => 'user-1',
      isJoinBlocked: () => false,
      beginConnecting: vi.fn(),
      attachRoomHandlers: vi.fn(),
      setLiveKitCredentials: vi.fn(),
      onRoomConnected: vi.fn(),
      onJoinSuccess: vi.fn(),
      abortJoin: vi.fn(),
      setConnectionPhase: vi.fn(),
    })

    await expectSuccessfulJoin(
      runner('group-channel', { operationId: 'op-join' }),
    )

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
        identity: 'user-1:desktop-native:op-join:microphone',
      },
      native_screen: {
        token: 'screen-token',
        identity: 'user-1:desktop-native:op-join:screen',
      },
      native_camera: {
        token: 'camera-token',
        identity: 'user-1:desktop-native:op-join:camera',
      },
    }

    expect(nativeCredentialsFromJoinResponse(response)).toEqual({
      microphone: {
        url: 'wss://livekit.example',
        token: 'mic-token',
        participantIdentity: 'user-1:desktop-native:op-join:microphone',
      },
      screen: {
        url: 'wss://livekit.example',
        token: 'screen-token',
        participantIdentity: 'user-1:desktop-native:op-join:screen',
      },
      camera: {
        url: 'wss://livekit.example',
        token: 'camera-token',
        participantIdentity: 'user-1:desktop-native:op-join:camera',
      },
    })
  })
})
