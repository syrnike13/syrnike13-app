import { describe, expect, it, vi } from 'vitest'

import { runVoiceRecovery } from '#/features/voice/voice-recovery-runner'
import type { VoiceRecoveryRunnerDeps } from '#/features/voice/voice-recovery-runner'

const USER_ID = 'user-1'
const CHANNEL_ID = 'channel-1'

function baseDeps(
  overrides: Partial<VoiceRecoveryRunnerDeps> = {},
): VoiceRecoveryRunnerDeps {
  return {
    getGatewayConnected: () => true,
    getActiveChannelId: () => CHANNEL_ID,
    getDesiredChannelId: () => CHANNEL_ID,
    getUserId: () => USER_ID,
    getStatus: () => 'connected',
    getVoiceParticipants: () => ({
      [CHANNEL_ID]: {
        [USER_ID]: {
          id: USER_ID,
          joined_at: 1,
          self_mute: false,
          self_deaf: false,
          server_muted: false,
          server_deafened: false,
          camera: false,
          screensharing: false,
          version: 1,
        },
      },
    }),
    canTrustServerState: () => true,
    getRoom: () => null,
    readCurrentVoiceFlags: () => ({ selfMute: false, selfDeaf: false }),
    readVoicePreferences: () => ({ micEnabled: true }),
    isSelfMonitoringActive: () => false,
    isPublisherHealthy: () => true,
    getPendingRejoinChannelId: () => null,
    getJoinInFlight: () => null,
    setJoinInFlight: vi.fn(),
    requestRejoinOperation: () => 'op-rejoin',
    stopRemoteSupersededVoiceSession: vi.fn(),
    syncVoiceFlagsToGateway: vi.fn(),
    shouldUseNativeMicrophone: () => false,
    startNativeMicrophone: vi.fn(async () => true),
    isCurrentVoiceSession: () => true,
    syncMicFromRoom: vi.fn(),
    syncRoomParticipants: vi.fn(),
    syncLocalSpeakingTrack: vi.fn(),
    activeChannelAudioBitrateKbps: () => 64,
    applyMicProcessing: vi.fn(async () => {}),
    getSelfDeafened: () => false,
    ...overrides,
  }
}

describe('runVoiceRecovery', () => {
  it('starts an executor-owned silent rejoin and tracks it as join-in-flight', async () => {
    const setJoinInFlight = vi.fn()
    const requestRejoinOperation = vi.fn(() => 'op-rejoin')
    const deps = baseDeps({
      getVoiceParticipants: () => ({}),
      setJoinInFlight,
      requestRejoinOperation,
    })

    runVoiceRecovery('gateway_connected', deps)

    expect(setJoinInFlight).toHaveBeenCalledWith({
      channelId: CHANNEL_ID,
      promise: expect.any(Promise),
    })
    const join = setJoinInFlight.mock.calls[0]?.[0]
    await join?.promise

    expect(requestRejoinOperation).toHaveBeenCalledWith(CHANNEL_ID, {
      reason: 'rejoin',
    })
  })

  it('does not start duplicate rejoin while pending or in-flight', () => {
    const requestRejoinOperation = vi.fn(() => 'op-rejoin')

    runVoiceRecovery(
      'gateway_connected',
      baseDeps({
        getVoiceParticipants: () => ({}),
        getPendingRejoinChannelId: () => CHANNEL_ID,
        requestRejoinOperation,
      }),
    )

    runVoiceRecovery(
      'health_tick',
      baseDeps({
        getVoiceParticipants: () => ({}),
        getJoinInFlight: () => ({
          channelId: CHANNEL_ID,
          promise: Promise.resolve(true),
        }),
        requestRejoinOperation,
      }),
    )

    expect(requestRejoinOperation).not.toHaveBeenCalled()
  })

  it('syncs voice flags when server flags differ from local intent', () => {
    const syncVoiceFlagsToGateway = vi.fn()
    const deps = baseDeps({
      readCurrentVoiceFlags: () => ({ selfMute: true, selfDeaf: false }),
      getVoiceParticipants: () => ({
        [CHANNEL_ID]: {
          [USER_ID]: {
            id: USER_ID,
            joined_at: 1,
            self_mute: false,
            self_deaf: false,
            server_muted: false,
            server_deafened: false,
            camera: false,
            screensharing: false,
            version: 1,
          },
        },
      }),
      syncVoiceFlagsToGateway,
    })

    runVoiceRecovery('health_tick', deps)

    expect(syncVoiceFlagsToGateway).toHaveBeenCalledWith(
      CHANNEL_ID,
      true,
      false,
    )
  })
})
