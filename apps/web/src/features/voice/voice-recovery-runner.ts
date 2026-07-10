import type { Room } from 'livekit-client'

import type { VoiceParticipantsByChannel } from '#/features/sync/voice-types'
import type { VoiceJoinReason } from '#/features/voice/voice-intent-director'
import { participantMicPublishing } from '#/features/voice/voice-participant-media'
import { decideVoiceRecoveryAction } from '#/features/voice/voice-recovery'
import { voiceMicPublishOptions } from '#/features/voice/voice-capture'
import type {
  VoiceMicIssue,
  VoiceStatus,
} from '#/features/voice/voice-mic-status'
import { describeMicDeviceError } from '#/features/voice/voice-mic-status'

type JoinInFlight = {
  channelId: string
  promise: Promise<boolean>
}

type VoiceFlags = {
  selfMute: boolean
  selfDeaf: boolean
}

type VoicePreferencesForRecovery = {
  micEnabled: boolean
}

export type VoiceRecoveryRunnerDeps = {
  getGatewayConnected: () => boolean
  getActiveChannelId: () => string | null
  getDesiredChannelId: () => string | null
  getUserId: () => string | null
  getStatus: () => VoiceStatus
  getVoiceParticipants: () => VoiceParticipantsByChannel
  canTrustServerState: (trigger: string) => boolean
  getRoom: () => Room | null
  readCurrentVoiceFlags: (room?: Room | null) => VoiceFlags
  readVoicePreferences: () => VoicePreferencesForRecovery
  isSelfMonitoringActive: () => boolean
  isPublisherHealthy: (room: Room | null) => boolean
  getPendingRejoinChannelId: () => string | null
  getJoinInFlight: () => JoinInFlight | null
  setJoinInFlight: (join: JoinInFlight | null) => void
  requestRejoinOperation: (
    channelId: string,
    options: { reason: Extract<VoiceJoinReason, 'rejoin'> },
  ) => string
  stopRemoteSupersededVoiceSession: (
    reason: string,
    targetChannelId?: string,
  ) => void
  syncVoiceFlagsToGateway: (
    channelId: string,
    selfMute: boolean,
    selfDeaf: boolean,
  ) => void
  shouldUseNativeMicrophone: () => boolean
  startNativeMicrophone: (room: Room, muted: boolean) => Promise<boolean>
  isCurrentVoiceSession: (
    room: Room,
    targetChannelId: string | null,
  ) => boolean
  syncMicFromRoom: (room: Room, issue?: VoiceMicIssue | null) => void
  syncRoomParticipants: () => void
  syncLocalSpeakingTrack: (room: Room) => void
  activeChannelAudioBitrateKbps: () => number
  applyMicProcessing: (participant: Room['localParticipant']) => Promise<unknown>
  getSelfDeafened: () => boolean
  /**
   * Опциональный in-flight guard для repair_publisher. Возвращает false, если
   * ремонт уже запущен (предотвращает дублирующие startNativeMicrophone /
   * setMicrophoneEnabled на быстрых health_tick). Реализация держит флаг до
   * завершения промиса ремонта.
   */
  tryStartPublisherRepair?: () => boolean
  endPublisherRepair?: (succeeded: boolean) => void
}

export function nativeOrBrowserPublisherHealthy(
  room: Room | null,
  deps: {
    shouldUseNativeMicrophone: () => boolean
    hasActiveNativeMicrophone: () => boolean
    isNativeMicrophoneMuted: () => boolean
  },
) {
  if (!room) return false
  if (deps.shouldUseNativeMicrophone()) {
    return deps.hasActiveNativeMicrophone() && !deps.isNativeMicrophoneMuted()
  }
  return participantMicPublishing(room.localParticipant)
}

export function runVoiceRecovery(
  trigger: string,
  deps: VoiceRecoveryRunnerDeps,
) {
  const activeChannelId = deps.getActiveChannelId()
  const room = deps.getRoom()
  const { selfMute, selfDeaf } = deps.readCurrentVoiceFlags(room)
  const prefs = deps.readVoicePreferences()
  const publisherHealthy = deps.isPublisherHealthy(room)
  const useNativeMicrophone = deps.shouldUseNativeMicrophone()

  const action = decideVoiceRecoveryAction({
    gatewayConnected: deps.getGatewayConnected(),
    channelId: activeChannelId,
    desiredChannelId: deps.getDesiredChannelId(),
    userId: deps.getUserId(),
    status: deps.getStatus(),
    voiceParticipants: deps.getVoiceParticipants(),
    canTrustServerState: deps.canTrustServerState(trigger),
    desiredSelfMute: selfMute,
    desiredSelfDeaf: selfDeaf,
    wantsMic: prefs.micEnabled,
    selfMonitoringActive: deps.isSelfMonitoringActive(),
    publisherHealthy,
    repairMutedPublisher: useNativeMicrophone,
  })

  if (action.type === 'none') return

  if (action.type === 'stop_superseded') {
    deps.stopRemoteSupersededVoiceSession(action.reason, action.channelId)
    return
  }

  if (action.type === 'rejoin') {
    const targetChannelId = action.channelId
    const pendingRejoin = deps.getPendingRejoinChannelId()
    if (pendingRejoin === targetChannelId) return
    if (deps.getJoinInFlight()?.channelId === targetChannelId) return

    console.warn('[voice-recovery] rejoining voice session', {
      trigger,
      reason: action.reason,
      channelId: targetChannelId,
      status: deps.getStatus(),
    })

    const promise = Promise.resolve().then(() => {
      deps.requestRejoinOperation(targetChannelId, {
        reason: 'rejoin',
      })
      return true
    })

    deps.setJoinInFlight({
      channelId: targetChannelId,
      promise,
    })
    void promise.finally(() => {
      if (deps.getJoinInFlight()?.channelId === targetChannelId) {
        deps.setJoinInFlight(null)
      }
    })
    return
  }

  if (!activeChannelId) return

  if (action.type === 'send_flags') {
    console.info('[voice-recovery] syncing voice flags', {
      trigger,
      reason: action.reason,
      channelId: activeChannelId,
      selfMute: action.selfMute,
      selfDeaf: action.selfDeaf,
    })
    deps.syncVoiceFlagsToGateway(
      activeChannelId,
      action.selfMute,
      action.selfDeaf,
    )
    return
  }

  if (action.type === 'repair_publisher') {
    if (!room) {
      console.warn('[voice-recovery] cannot repair publisher without room', {
        trigger,
        channelId: activeChannelId,
      })
      return
    }

    // In-flight guard: не запускаем повторный ремонт, пока предыдущий не дошёл.
    // Предотвращает дублирующие startNativeMicrophone / setMicrophoneEnabled
    // на быстрых health_tick-срабатываниях.
    if (deps.tryStartPublisherRepair && !deps.tryStartPublisherRepair()) {
      return
    }
    let repairSucceeded = false
    const finishRepair = () => deps.endPublisherRepair?.(repairSucceeded)

    console.warn('[voice-recovery] repairing voice publisher', {
      trigger,
      reason: action.reason,
      channelId: activeChannelId,
    })

    if (useNativeMicrophone) {
      void Promise.resolve()
        .then(() => deps.startNativeMicrophone(room, false))
        .then((started) => {
          if (!started || !deps.isCurrentVoiceSession(room, activeChannelId)) {
            return
          }
          deps.syncMicFromRoom(room)
          deps.syncRoomParticipants()
          const flags = deps.readCurrentVoiceFlags(room)
          deps.syncVoiceFlagsToGateway(
            activeChannelId,
            flags.selfMute,
            flags.selfDeaf,
          )
          repairSucceeded = true
        })
        .catch((error) => {
          if (!deps.isCurrentVoiceSession(room, activeChannelId)) {
            return
          }
          deps.syncMicFromRoom(room, {
            ...describeMicDeviceError(error),
            retryable: true,
          })
          deps.syncRoomParticipants()
          deps.syncVoiceFlagsToGateway(
            activeChannelId,
            true,
            deps.getSelfDeafened(),
          )
        })
        .finally(finishRepair)
      return
    }

    void Promise.resolve()
      .then(() =>
        room.localParticipant.setMicrophoneEnabled(
          true,
          undefined,
          voiceMicPublishOptions(deps.activeChannelAudioBitrateKbps()),
        ),
      )
      .then(() => deps.applyMicProcessing(room.localParticipant))
      .then(() => {
        if (!deps.isCurrentVoiceSession(room, activeChannelId)) {
          return
        }
        deps.syncLocalSpeakingTrack(room)
        deps.syncMicFromRoom(room)
        deps.syncRoomParticipants()
        const flags = deps.readCurrentVoiceFlags(room)
        deps.syncVoiceFlagsToGateway(
          activeChannelId,
          flags.selfMute,
          flags.selfDeaf,
        )
        repairSucceeded = true
      })
      .catch((error) => {
        if (!deps.isCurrentVoiceSession(room, activeChannelId)) {
          return
        }
        deps.syncMicFromRoom(room, describeMicDeviceError(error))
        deps.syncRoomParticipants()
        deps.syncVoiceFlagsToGateway(
          activeChannelId,
          true,
          deps.getSelfDeafened(),
        )
      })
      .finally(finishRepair)
  }
}
