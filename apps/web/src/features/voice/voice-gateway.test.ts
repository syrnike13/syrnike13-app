import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendReliable = vi.fn()
let eventHandlers: ((event: { type: string; [key: string]: unknown }) => void)[] =
  []
let stateHandler: ((state: string) => void) | null = null

vi.mock('#/features/events/gateway', () => ({
  eventsGateway: {
    state: 'connected',
    sendReliable,
    subscribeEvents: vi.fn((handler) => {
      eventHandlers.push(handler)
      return vi.fn()
    }),
    subscribeState: vi.fn((handler) => {
      stateHandler = handler
      return vi.fn()
    }),
  },
}))

vi.mock('#/features/voice/voice-node', () => ({
  resolveVoiceNodeName: vi.fn(async () => 'node-1'),
}))

describe('voice gateway reliable state updates', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    eventHandlers = []
    stateHandler = null
  })

  function emitEvent(event: { type: string; [key: string]: unknown }) {
    for (const handler of eventHandlers) {
      handler(event)
    }
  }

  it('sends voice state updates with a nonce and retries until ack', async () => {
    const { sendVoiceStateUpdate } = await import('./voice-gateway')

    sendVoiceStateUpdate({
      request: { mode: 'join', operation_id: 'op-join' },
      channel_id: 'channel-1',
      self_mute: false,
      self_deaf: false,
    })

    const firstEvent = sendReliable.mock.calls[0]?.[0]
    expect(firstEvent).toMatchObject({
      type: 'VoiceStateUpdate',
      request: { mode: 'join', operation_id: 'op-join' },
      channel_id: 'channel-1',
      self_mute: false,
      self_deaf: false,
      nonce: expect.any(String),
    })
    expect(sendReliable.mock.calls[0]?.[1]).toBe('voice-operation:op-join')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendReliable).toHaveBeenCalledTimes(2)
    expect(sendReliable.mock.calls[1]?.[0]).toEqual(firstEvent)

    emitEvent({
      type: 'VoiceStateAck',
      nonce: firstEvent.nonce,
      channel_id: 'channel-1',
      ok: true,
    })

    await vi.advanceTimersByTimeAsync(15_000)
    expect(sendReliable).toHaveBeenCalledTimes(2)
  })

  it('keeps control-operation retry independent from coalesced flag updates', async () => {
    const { sendVoiceStateUpdate } = await import('./voice-gateway')

    sendVoiceStateUpdate({
      request: { mode: 'replace_operation', operation_id: 'op-b', expected_current_operation_id: 'op-a' },
      channel_id: 'channel-b',
      self_mute: false,
      self_deaf: false,
    })
    sendVoiceStateUpdate({
      request: { mode: 'join', operation_id: 'op-a' },
      channel_id: 'channel-a',
      self_mute: true,
      self_deaf: false,
      suppress_call_notifications: true,
    })

    const operationEvent = sendReliable.mock.calls[0]?.[0]
    const flagsEvent = sendReliable.mock.calls[1]?.[0]
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sendReliable).toHaveBeenCalledTimes(4)
    expect(sendReliable.mock.calls[2]?.[0]).toEqual(operationEvent)
    expect(sendReliable.mock.calls[3]?.[0]).toEqual(flagsEvent)

    emitEvent({
      type: 'VoiceStateAck',
      nonce: operationEvent.nonce,
      channel_id: 'channel-b',
      ok: true,
    })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sendReliable).toHaveBeenCalledTimes(5)
    expect(sendReliable.mock.calls[4]?.[0]).toEqual(flagsEvent)
  })

  it('drops pending ack retry when gateway becomes idle', async () => {
    const { sendVoiceStateUpdate } = await import('./voice-gateway')

    sendVoiceStateUpdate({
      request: { mode: 'join', operation_id: 'op-join' },
      channel_id: 'channel-1',
      self_mute: false,
      self_deaf: false,
    })
    stateHandler?.('idle')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendReliable).toHaveBeenCalledTimes(1)
  })

  it('treats matching voice server update as an implicit ack for join intents', async () => {
    const { sendVoiceStateUpdate } = await import('./voice-gateway')

    sendVoiceStateUpdate({
      request: { mode: 'join', operation_id: 'op-join' },
      channel_id: 'channel-1',
      self_mute: false,
      self_deaf: false,
      node: 'node-1',
    })

    emitEvent({
      type: 'VoiceServerUpdate',
      operation_id: 'op-join',
      channel_id: 'channel-1',
      node: 'node-1',
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendReliable).toHaveBeenCalledTimes(1)
  })

  it('does not treat voice server update as an implicit ack for flag-only updates', async () => {
    const { sendVoiceStateUpdate } = await import('./voice-gateway')

    sendVoiceStateUpdate({
      request: { mode: 'join', operation_id: 'op-current' },
      channel_id: 'channel-1',
      self_mute: true,
      self_deaf: false,
      suppress_call_notifications: true,
    })

    emitEvent({
      type: 'VoiceServerUpdate',
      channel_id: 'channel-1',
      node: 'node-1',
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendReliable).toHaveBeenCalledTimes(2)
  })

  it('requests fresh credentials when joining a channel that may already contain this user', async () => {
    const { requestVoiceJoin } = await import('./voice-gateway')

    const joinPromise = requestVoiceJoin('channel-1', false, false, {
      operationId: 'op-join',
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendReliable.mock.calls[0]?.[0]).toMatchObject({
      type: 'VoiceStateUpdate',
      channel_id: 'channel-1',
      request: { mode: 'join', operation_id: 'op-join' },
      self_mute: false,
      self_deaf: false,
      node: 'node-1',
    })
    expect(sendReliable.mock.calls[0]?.[0]).not.toHaveProperty(
      'force_disconnect',
    )

    emitEvent({
      type: 'VoiceServerUpdate',
      operation_id: 'op-join',
      channel_id: 'channel-1',
      node: 'node-1',
      url: 'wss://livekit.example',
      token: 'browser-token',
      native_microphone: { token: 'mic-token', identity: 'user-1:mic' },
      native_screen: { token: 'screen-token', identity: 'user-1:screen' },
      native_camera: { token: 'camera-token', identity: 'user-1:camera' },
    })

    await expect(joinPromise).resolves.toMatchObject({
      type: 'VoiceServerUpdate',
      channel_id: 'channel-1',
    })
  })

  it('matches voice server updates by operation id instead of channel only', async () => {
    const { requestVoiceJoin } = await import('./voice-gateway')

    const joinPromise = requestVoiceJoin('channel-1', false, false, {
      operationId: 'op-join',
    })
    let resolved = false
    void joinPromise.then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendReliable.mock.calls[0]?.[0]).toMatchObject({
      type: 'VoiceStateUpdate',
      channel_id: 'channel-1',
      request: { mode: 'join', operation_id: 'op-join' },
    })
    expect(sendReliable.mock.calls[0]?.[1]).toBe('voice-operation:op-join')

    emitEvent({
      type: 'VoiceServerUpdate',
      operation_id: 'op-stale',
      channel_id: 'channel-1',
      node: 'node-1',
      url: 'wss://livekit.example',
      token: 'stale-browser-token',
      native_microphone: { token: 'stale-mic-token', identity: 'user-1:mic' },
      native_screen: { token: 'stale-screen-token', identity: 'user-1:screen' },
      native_camera: { token: 'stale-camera-token', identity: 'user-1:camera' },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(false)

    emitEvent({
      type: 'VoiceServerUpdate',
      operation_id: 'op-join',
      channel_id: 'channel-1',
      node: 'node-1',
      url: 'wss://livekit.example',
      token: 'browser-token',
      native_microphone: { token: 'mic-token', identity: 'user-1:mic' },
      native_screen: { token: 'screen-token', identity: 'user-1:screen' },
      native_camera: { token: 'camera-token', identity: 'user-1:camera' },
    })

    await expect(joinPromise).resolves.toMatchObject({
      type: 'VoiceServerUpdate',
      operation_id: 'op-join',
      channel_id: 'channel-1',
    })
  })

  it('dispatches an explicit CAS operation replacement without resolving a new node', async () => {
    const { requestVoiceJoin } = await import('./voice-gateway')
    const onDispatched = vi.fn()

    const restorePromise = requestVoiceJoin('channel-a', false, false, {
      operationId: 'op-restore-a',
      expectedCurrentOperationId: 'op-move-b',
      onDispatched,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendReliable.mock.calls[0]?.[0]).toMatchObject({
      type: 'VoiceStateUpdate',
      channel_id: 'channel-a',
      request: {
        mode: 'replace_operation',
        operation_id: 'op-restore-a',
        expected_current_operation_id: 'op-move-b',
      },
    })
    expect(sendReliable.mock.calls[0]?.[0]).not.toHaveProperty('node')
    expect(onDispatched).toHaveBeenCalledTimes(1)

    emitEvent({
      type: 'VoiceServerUpdate',
      operation_id: 'op-restore-a',
      channel_id: 'channel-a',
      node: 'node-1',
      url: 'wss://livekit.example',
      token: 'browser-token',
      native_microphone: { token: 'mic-token', identity: 'user-1:mic' },
      native_screen: { token: 'screen-token', identity: 'user-1:screen' },
      native_camera: { token: 'camera-token', identity: 'user-1:camera' },
    })

    await expect(restorePromise).resolves.toMatchObject({
      operation_id: 'op-restore-a',
      channel_id: 'channel-a',
    })
  })

  it('uses the distinct retain_finalized CAS for a live retained room', async () => {
    const { requestVoiceJoin } = await import('./voice-gateway')

    const retainPromise = requestVoiceJoin('channel-a', false, false, {
      operationId: 'op-finalized-a',
      expectedCurrentOperationId: 'op-candidate-b',
      retainFinalized: true,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendReliable.mock.calls[0]?.[0]).toMatchObject({
      request: {
        mode: 'retain_finalized',
        operation_id: 'op-finalized-a',
        expected_current_operation_id: 'op-candidate-b',
      },
    })
    emitEvent({
      type: 'VoiceServerUpdate',
      operation_id: 'op-finalized-a',
      channel_id: 'channel-a',
      node: 'node-1',
      url: 'wss://livekit.example',
      token: 'browser-token',
      native_microphone: { token: 'mic-token', identity: 'user-1:mic' },
      native_screen: { token: 'screen-token', identity: 'user-1:screen' },
      native_camera: { token: 'camera-token', identity: 'user-1:camera' },
    })

    await expect(retainPromise).resolves.toMatchObject({
      operation_id: 'op-finalized-a',
    })
  })

  it('keeps observing an already-dispatched request after local supersession', async () => {
    const { requestVoiceJoin } = await import('./voice-gateway')
    const abortController = new AbortController()

    const joinPromise = requestVoiceJoin('channel-b', false, false, {
      operationId: 'op-move-b',
      signal: abortController.signal,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(sendReliable).toHaveBeenCalledTimes(1)

    abortController.abort()

    expect(sendReliable).toHaveBeenCalledTimes(1)
    emitEvent({
      type: 'VoiceServerUpdate',
      operation_id: 'op-move-b',
      channel_id: 'channel-b',
      node: 'node-1',
      url: 'wss://livekit.example',
      token: 'browser-token',
      native_microphone: { token: 'mic-token', identity: 'user-1:mic' },
      native_screen: { token: 'screen-token', identity: 'user-1:screen' },
      native_camera: { token: 'camera-token', identity: 'user-1:camera' },
    })
    await expect(joinPromise).resolves.toMatchObject({ operation_id: 'op-move-b' })
  })

  it('ignores recoverable voice errors for a different operation while waiting for credentials', async () => {
    const { requestVoiceJoin } = await import('./voice-gateway')

    const joinPromise = requestVoiceJoin('channel-1', false, false, {
      operationId: 'op-join',
    })
    await vi.advanceTimersByTimeAsync(0)

    emitEvent({
      type: 'Error',
      fatal: false,
      scope: 'VoiceStateUpdate',
      request: {
        kind: 'VoiceStateUpdate',
        operation_id: 'op-other',
        channel_id: 'channel-1',
      },
      data: { type: 'InvalidOperation' },
    })

    emitEvent({
      type: 'VoiceServerUpdate',
      operation_id: 'op-join',
      channel_id: 'channel-1',
      node: 'node-1',
      url: 'wss://livekit.example',
      token: 'browser-token',
      native_microphone: { token: 'mic-token', identity: 'user-1:mic' },
      native_screen: { token: 'screen-token', identity: 'user-1:screen' },
      native_camera: { token: 'camera-token', identity: 'user-1:camera' },
    })

    await expect(joinPromise).resolves.toMatchObject({
      type: 'VoiceServerUpdate',
      operation_id: 'op-join',
      channel_id: 'channel-1',
    })
  })

  it('rejects credentials wait on matching recoverable voice errors', async () => {
    const { requestVoiceJoin } = await import('./voice-gateway')

    const joinPromise = requestVoiceJoin('channel-1', false, false, {
      operationId: 'op-join',
    })
    await vi.advanceTimersByTimeAsync(0)

    emitEvent({
      type: 'Error',
      fatal: false,
      scope: 'VoiceStateUpdate',
      request: {
        kind: 'VoiceStateUpdate',
        operation_id: 'op-join',
        channel_id: 'channel-1',
        authoritative_operation_id: 'op-current',
        authoritative_channel_id: 'channel-current',
      },
      data: { type: 'InvalidOperation', message: 'Voice join rejected' },
    })

    await expect(joinPromise).rejects.toMatchObject({
      message: 'Voice join rejected',
      authoritativeOperationId: 'op-current',
      authoritativeChannelId: 'channel-current',
    })
  })

  it('rejects credentials wait immediately on malformed gateway errors', async () => {
    const { requestVoiceJoin } = await import('./voice-gateway')

    const joinPromise = requestVoiceJoin('channel-1', false, false, {
      operationId: 'op-join',
    })
    await vi.advanceTimersByTimeAsync(0)
    const rejection = expect(joinPromise).rejects.toThrow(
      'Malformed voice error',
    )

    emitEvent({
      type: 'Error',
      data: { type: 'InvalidOperation', message: 'Malformed voice error' },
    })

    await rejection
  })

  it('suppresses call notifications when refreshing voice credentials', async () => {
    const { requestVoiceCredentialsRefresh } = await import('./voice-gateway')

    const refreshPromise = requestVoiceCredentialsRefresh(
      'channel-1',
      false,
      false,
      'op-refresh',
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(sendReliable.mock.calls[0]?.[0]).toMatchObject({
      type: 'VoiceStateUpdate',
      channel_id: 'channel-1',
      request: {
        mode: 'refresh_credentials',
        operation_id: 'op-refresh',
      },
      suppress_call_notifications: true,
    })
    expect(sendReliable.mock.calls[0]?.[0]).not.toHaveProperty(
      'force_disconnect',
    )
    expect(sendReliable.mock.calls[0]?.[1]).toBe('voice-operation:op-refresh')

    emitEvent({
      type: 'VoiceServerUpdate',
      operation_id: 'op-refresh',
      channel_id: 'channel-1',
      node: 'node-1',
      url: 'wss://livekit.example',
      token: 'browser-token',
      native_microphone: { token: 'mic-token', identity: 'user-1:mic' },
      native_screen: { token: 'screen-token', identity: 'user-1:screen' },
      native_camera: { token: 'camera-token', identity: 'user-1:camera' },
    })

    await expect(refreshPromise).resolves.toMatchObject({
      type: 'VoiceServerUpdate',
      channel_id: 'channel-1',
    })
  })

  it('suppresses call notifications for voice flag updates', async () => {
    const { requestVoiceFlagsUpdate } = await import('./voice-gateway')

    requestVoiceFlagsUpdate('channel-1', true, false, 'op-current')

    expect(sendReliable.mock.calls[0]?.[0]).toMatchObject({
      type: 'VoiceStateUpdate',
      channel_id: 'channel-1',
      request: { mode: 'join', operation_id: 'op-current' },
      self_mute: true,
      self_deaf: false,
      suppress_call_notifications: true,
    })
    expect(sendReliable.mock.calls[0]?.[0]).not.toHaveProperty(
      'force_disconnect',
    )
    expect(sendReliable.mock.calls[0]?.[1]).toBe('voice-flags:channel-1')
  })

  it('sends suppress_call_notifications for silent voice rejoins', async () => {
    const { requestVoiceJoin } = await import('./voice-gateway')

    const joinPromise = requestVoiceJoin('channel-1', false, false, {
      operationId: 'op-rejoin',
      suppress_call_notifications: true,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendReliable.mock.calls[0]?.[0]).toMatchObject({
      type: 'VoiceStateUpdate',
      channel_id: 'channel-1',
      request: { mode: 'join', operation_id: 'op-rejoin' },
      suppress_call_notifications: true,
    })

    emitEvent({
      type: 'VoiceServerUpdate',
      operation_id: 'op-rejoin',
      channel_id: 'channel-1',
      node: 'node-1',
      url: 'wss://livekit.example',
      token: 'browser-token',
      native_microphone: { token: 'mic-token', identity: 'user-1:mic' },
      native_screen: { token: 'screen-token', identity: 'user-1:screen' },
      native_camera: { token: 'camera-token', identity: 'user-1:camera' },
    })

    await expect(joinPromise).resolves.toMatchObject({
      type: 'VoiceServerUpdate',
      channel_id: 'channel-1',
    })
  })
})
