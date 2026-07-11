import { describe, expect, it, vi } from 'vitest'

import type { VoiceReservationRequest } from './voice-authority'
import {
  GatewayVoiceAuthorityAdapter,
  type VoiceGatewayTransport,
  type VoiceGatewayTransportState,
} from './gateway-voice-authority-adapter'

class FakeTransport implements VoiceGatewayTransport {
  readonly sent: Array<{ message: Record<string, unknown>; key: string }> = []
  private readonly eventListeners = new Set<
    (event: Record<string, unknown>) => void
  >()
  private readonly stateListeners = new Set<
    (state: VoiceGatewayTransportState) => void
  >()

  sendReliable(message: Record<string, unknown>, key: string) {
    this.sent.push({ message, key })
  }

  subscribeEvents(listener: (event: Record<string, unknown>) => void) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  subscribeState(listener: (state: VoiceGatewayTransportState) => void) {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  event(event: Record<string, unknown>) {
    for (const listener of this.eventListeners) listener(event)
  }

  state(state: VoiceGatewayTransportState) {
    for (const listener of this.stateListeners) listener(state)
  }
}

const reservation: VoiceReservationRequest = {
  channelId: 'channel-a',
  rtcEngine: 'windows_native',
  clientInstanceId: 'client-a',
  operationId: 'voice-op-a',
  connectionEpoch: 'epoch-a',
  media: {
    userMuted: true,
    userDeafened: false,
    serverMuted: false,
    serverDeafened: false,
    systemPrivacyMuted: false,
    monitoringMuted: false,
    inputMode: 'voice_activity',
    pushToTalkHeld: false,
    effectiveMuted: true,
    noiseSuppression: true,
    echoCancellation: true,
    inputVolume: 1,
    voiceGateEnabled: true,
    voiceGateThresholdDb: -28,
    voiceGateAutoThreshold: true,
    outputVolume: 1,
    cameraEnabled: false,
    screenEnabled: false,
    screenAudioEnabled: false,
  },
}

describe('GatewayVoiceAuthorityAdapter', () => {
  it('sends exact engine claims and validates the returned credential lease', async () => {
    const transport = new FakeTransport()
    const adapter = new GatewayVoiceAuthorityAdapter({
      transport,
      resolveJoinMetadata: () => ({ node: 'node-a' }),
    })
    const pending = adapter.reserve(reservation, new AbortController().signal)
    await Promise.resolve()

    expect(transport.sent.at(-1)).toMatchObject({
      key: 'voice-operation:voice-op-a',
      message: {
        type: 'VoiceStateUpdate',
        channel_id: 'channel-a',
        self_mute: true,
        self_deaf: false,
        node: 'node-a',
        request: {
          mode: 'join',
          operation_id: 'voice-op-a',
          rtc_engine: 'windows_native',
          client_instance_id: 'client-a',
          connection_epoch: 'epoch-a',
        },
      },
    })

    transport.event({
      type: 'VoiceServerUpdate',
      operation_id: 'voice-op-a',
      authority_version: 3,
      channel_id: 'channel-a',
      node: 'node-a',
      url: 'wss://voice.invalid',
      credential: {
        rtc_engine: 'windows_native',
        client_instance_id: 'client-a',
        connection_epoch: 'epoch-a',
        token: 'secret-token',
        identity: 'voice:v1|windows_native|client-a|epoch-a|voice-op-a|user-a',
      },
    })

    await expect(pending).resolves.toMatchObject({
      channelId: 'channel-a',
      operationId: 'voice-op-a',
      authorityVersion: 3,
      credential: {
        url: 'wss://voice.invalid',
        participantIdentity:
          'voice:v1|windows_native|client-a|epoch-a|voice-op-a|user-a',
      },
    })
    adapter.dispose()
  })

  it('emits only complete, versioned authoritative membership snapshots', () => {
    const transport = new FakeTransport()
    const adapter = new GatewayVoiceAuthorityAdapter({ transport })
    const listener = vi.fn()
    adapter.subscribe(listener)

    transport.event({
      type: 'VoiceAuthoritySnapshot',
      version: 9,
      operation_id: 'voice-op-a',
      channel_id: 'channel-a',
      rtc_engine: 'windows_native',
      client_instance_id: 'client-a',
      connection_epoch: 'epoch-a',
      state: { server_muted: true, server_deafened: false },
    })

    expect(listener).toHaveBeenCalledWith({
      type: 'snapshot',
      snapshot: {
        authorityVersion: 9,
        complete: true,
        membership: {
          operationId: 'voice-op-a',
          channelId: 'channel-a',
          rtcEngine: 'windows_native',
          clientInstanceId: 'client-a',
          connectionEpoch: 'epoch-a',
        },
        serverMuted: true,
        serverDeafened: false,
      },
    })
    adapter.dispose()
  })

  it('uses exact claims for flag updates and release', async () => {
    const transport = new FakeTransport()
    const adapter = new GatewayVoiceAuthorityAdapter({ transport })
    const flags = adapter.updateSelfState({
      channelId: reservation.channelId,
      rtcEngine: reservation.rtcEngine,
      clientInstanceId: reservation.clientInstanceId,
      operationId: reservation.operationId,
      connectionEpoch: reservation.connectionEpoch,
      userMuted: false,
      userDeafened: true,
    })
    const flagMessage = transport.sent.at(-1)!.message
    transport.event({
      type: 'VoiceStateAck',
      nonce: flagMessage.nonce,
      ok: true,
    })
    await flags

    const release = adapter.cancel({
      rtcEngine: reservation.rtcEngine,
      clientInstanceId: reservation.clientInstanceId,
      operationId: reservation.operationId,
      connectionEpoch: reservation.connectionEpoch,
      reason: 'leave',
    })
    const releaseMessage = transport.sent.at(-1)!.message
    expect(releaseMessage).toMatchObject({
      channel_id: null,
      request: {
        mode: 'disconnect',
        operation_id: 'voice-op-a',
        rtc_engine: 'windows_native',
        client_instance_id: 'client-a',
        connection_epoch: 'epoch-a',
      },
    })
    transport.event({
      type: 'VoiceStateAck',
      nonce: releaseMessage.nonce,
      ok: true,
    })
    await release
    adapter.dispose()
  })

  it('emits only a fully exact unsolicited administrative move', () => {
    const transport = new FakeTransport()
    const adapter = new GatewayVoiceAuthorityAdapter({ transport })
    const listener = vi.fn()
    adapter.subscribe(listener)

    transport.event({
      type: 'VoiceAuthorityMove',
      from: {
        operation_id: 'voice-op-a',
        channel_id: 'channel-a',
        rtc_engine: 'windows_native',
        client_instance_id: 'client-a',
        connection_epoch: 'epoch-a',
      },
      lease: {
        operation_id: 'voice-op-b',
        authority_version: 11,
        channel_id: 'channel-b',
        node: 'node-b',
        url: 'wss://voice.invalid',
        credential: {
          rtc_engine: 'windows_native',
          client_instance_id: 'client-a',
          connection_epoch: 'epoch-b',
          token: 'secret-b',
          identity: 'identity-b',
        },
      },
    })

    expect(listener).toHaveBeenCalledWith({
      type: 'forcedMove',
      from: {
        operationId: 'voice-op-a',
        channelId: 'channel-a',
        rtcEngine: 'windows_native',
        clientInstanceId: 'client-a',
        connectionEpoch: 'epoch-a',
      },
      lease: {
        operationId: 'voice-op-b',
        authorityVersion: 11,
        channelId: 'channel-b',
        rtcEngine: 'windows_native',
        clientInstanceId: 'client-a',
        connectionEpoch: 'epoch-b',
        credential: {
          url: 'wss://voice.invalid',
          token: 'secret-b',
          participantIdentity: 'identity-b',
        },
      },
    })

    listener.mockClear()
    transport.event({
      type: 'VoiceAuthorityMove',
      from: { operation_id: 'missing-exact-fields' },
      lease: {},
    })
    transport.event({
      type: 'UserMoveVoiceChannel',
      from: 'channel-a',
      to: 'channel-b',
      token: 'legacy-secret',
    })
    expect(listener).not.toHaveBeenCalled()
    adapter.dispose()
  })

  it('aborts a pending reservation without accepting a late credential', async () => {
    const transport = new FakeTransport()
    const adapter = new GatewayVoiceAuthorityAdapter({ transport })
    const abort = new AbortController()
    const pending = adapter.reserve(reservation, abort.signal)
    await Promise.resolve()
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(transport.sent.at(-1)).toMatchObject({
      key: 'voice-operation:voice-op-a',
      message: {
        request: {
          mode: 'disconnect',
          operation_id: 'voice-op-a',
          rtc_engine: 'windows_native',
          client_instance_id: 'client-a',
          connection_epoch: 'epoch-a',
        },
      },
    })
    adapter.dispose()
  })
})
