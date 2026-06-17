import { describe, expect, it } from 'vitest'

import { decideVoiceRecoveryAction } from './voice-recovery'

const USER_ID = 'user-1'
const CHANNEL_ID = 'channel-1'

function baseInput(
  overrides: Partial<Parameters<typeof decideVoiceRecoveryAction>[0]> = {},
) {
  return {
    gatewayConnected: true,
    channelId: CHANNEL_ID,
    userId: USER_ID,
    status: 'connected' as const,
    desiredChannelId: CHANNEL_ID,
    voiceParticipants: {
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
    },
    canTrustServerState: true,
    desiredSelfMute: false,
    desiredSelfDeaf: false,
    wantsMic: true,
    selfMonitoringActive: false,
    publisherHealthy: true,
    ...overrides,
  }
}

describe('decideVoiceRecoveryAction', () => {
  it('waits while gateway is disconnected', () => {
    expect(
      decideVoiceRecoveryAction(baseInput({ gatewayConnected: false })),
    ).toEqual({ type: 'none', reason: 'gateway_disconnected' })
  })

  it('rejoins when the server snapshot no longer contains the local user', () => {
    expect(
      decideVoiceRecoveryAction(baseInput({ voiceParticipants: {} })),
    ).toEqual({
      type: 'rejoin',
      reason: 'missing_server_state',
      channelId: CHANNEL_ID,
    })
  })

  it('rejoins the desired channel when local LiveKit state is not connected', () => {
    expect(
      decideVoiceRecoveryAction(
        baseInput({
          status: 'connecting',
          channelId: null,
          desiredChannelId: CHANNEL_ID,
          voiceParticipants: {},
          canTrustServerState: true,
          publisherHealthy: false,
        }),
      ),
    ).toEqual({
      type: 'rejoin',
      reason: 'missing_server_state',
      channelId: CHANNEL_ID,
    })
  })

  it('rejoins the desired channel when local LiveKit state is gone but server state still exists', () => {
    expect(
      decideVoiceRecoveryAction(
        baseInput({
          status: 'connecting',
          channelId: null,
          desiredChannelId: CHANNEL_ID,
          canTrustServerState: true,
        }),
      ),
    ).toEqual({
      type: 'rejoin',
      reason: 'local_not_connected',
      channelId: CHANNEL_ID,
    })
  })

  it('stops instead of rejoining when the server moved the local user elsewhere', () => {
    expect(
      decideVoiceRecoveryAction(
        baseInput({
          voiceParticipants: {
            'channel-2': {
              [USER_ID]: {
                id: USER_ID,
                joined_at: 2,
                self_mute: false,
                self_deaf: false,
                server_muted: false,
                server_deafened: false,
                camera: false,
                screensharing: false,
                version: 2,
              },
            },
          },
        }),
      ),
    ).toEqual({
      type: 'stop_superseded',
      reason: 'server_state_moved_elsewhere',
      channelId: 'channel-2',
    })
  })

  it('does not rejoin on a missing server state before the snapshot is trusted', () => {
    expect(
      decideVoiceRecoveryAction(
        baseInput({
          voiceParticipants: {},
          canTrustServerState: false,
        }),
      ),
    ).toEqual({ type: 'none', reason: 'healthy' })
  })

  it('repairs publisher when local intent wants mic but publisher is unhealthy', () => {
    expect(
      decideVoiceRecoveryAction(baseInput({ publisherHealthy: false })),
    ).toEqual({ type: 'repair_publisher', reason: 'publisher_unhealthy' })
  })

  it('sends flags when server voice flags differ from local intent', () => {
    expect(
      decideVoiceRecoveryAction(
        baseInput({
          voiceParticipants: {
            [CHANNEL_ID]: {
              [USER_ID]: {
                id: USER_ID,
                joined_at: 1,
                self_mute: true,
                self_deaf: false,
                server_muted: false,
                server_deafened: false,
                camera: false,
                screensharing: false,
                version: 1,
              },
            },
          },
        }),
      ),
    ).toEqual({
      type: 'send_flags',
      reason: 'flags_mismatch',
      selfMute: false,
      selfDeaf: false,
    })
  })

  it('does not repair a muted or self-monitoring microphone', () => {
    expect(
      decideVoiceRecoveryAction(
        baseInput({
          desiredSelfMute: true,
          wantsMic: false,
          publisherHealthy: false,
        }),
      ),
    ).toEqual({
      type: 'send_flags',
      reason: 'flags_mismatch',
      selfMute: true,
      selfDeaf: false,
    })

    expect(
      decideVoiceRecoveryAction(
        baseInput({
          desiredSelfMute: true,
          selfMonitoringActive: true,
          publisherHealthy: false,
        }),
      ),
    ).toEqual({
      type: 'send_flags',
      reason: 'flags_mismatch',
      selfMute: true,
      selfDeaf: false,
    })
  })
})
