import type { Room } from 'livekit-client'

import { participantMicPublishing } from '#/features/voice/voice-participant-media'
import {
  shouldResetMicPreferenceOnIssue,
  type VoiceConnectionPhase,
  type VoiceMicIssue,
} from '#/features/voice/voice-mic-status'

const DEVICE_SWITCH_TIMEOUT_MS = 5_000

export type CurrentVoiceFlagsOptions = {
  room: Room | null
  selfDeaf: boolean
  selfMonitoringActive: boolean
  shouldUseNativeMicrophone: boolean
  hasNativeMicrophone: boolean
  nativeMicrophoneMuted: boolean
  fallbackMicPublishing: boolean
}

export type VoicePreferencesSnapshot = {
  micEnabled: boolean
  deafened: boolean
  preferredAudioInputDevice?: string
  preferredAudioOutputDevice?: string
}

export type RestoreVoicePreferencesDeps = {
  readPreferences: () => VoicePreferencesSnapshot
  setMicEnabled: (enabled: boolean) => void
  setMicPublishing: (publishing: boolean) => void
  setCurrentMicIssue: (issue: null) => void
  setDeafened: (deafened: boolean) => void
  setDeafenedRef: (deafened: boolean) => void
}

export type ApplyVoiceDevicesDeps = {
  room: Room
  readPreferences: () => VoicePreferencesSnapshot
  shouldUseNativeMicrophone: boolean
  setRemoteAudioOutputDevice: (deviceId: string | undefined) => void
  applyRemoteAudio: (deafened: boolean) => void
  isDeafened: () => boolean
}

export type SyncMicFromRoomDeps = {
  room: Room
  issue?: VoiceMicIssue | null
  wantsMic: boolean
  shouldUseNativeMicrophone: boolean
  hasNativeMicrophone: boolean
  nativeMicrophoneMuted: boolean
  activeChannelId: string | null
  userId: string | null
  currentMicIssue: VoiceMicIssue | null
  fallbackIssue: VoiceMicIssue
  setMicPublishing: (publishing: boolean) => void
  resetMicPreference: (enabled: false) => void
  setMicEnabled: (enabled: boolean) => void
  setCurrentMicIssue: (issue: VoiceMicIssue | null, notify?: boolean) => void
  patchLocalVoiceMic: (
    channelId: string,
    userId: string,
    publishing: boolean,
  ) => void
}

export type FinishLocalVoiceSetupDeps = {
  room: Room
  targetChannelId: string
  isCurrentVoiceSession: (room: Room, targetChannelId: string) => boolean
  readPreferences: () => VoicePreferencesSnapshot
  getMicEnabledPreference: () => boolean
  selfMonitoringActive: boolean
  setSelfMonitoringRestorePublishing: (restorePublishing: boolean) => void
  shouldUseNativeMicrophone: boolean
  startNativeMicrophone: (room: Room, muted: boolean) => Promise<boolean>
  voiceMicPublishOptions: (
    activeChannelAudioBitrateKbps: number,
  ) => Parameters<Room['localParticipant']['setMicrophoneEnabled']>[2]
  activeChannelAudioBitrateKbps: () => number
  describeMicDeviceError: (error: unknown) => VoiceMicIssue
  setConnectionPhase: (phase: VoiceConnectionPhase) => void
  syncMicFromRoom: (room: Room, issue?: VoiceMicIssue | null) => void
  setMicEnabled: (enabled: boolean) => void
  setMicPublishing: (publishing: boolean) => void
  setCurrentMicIssue: (issue: null) => void
  setDeafened: (deafened: boolean) => void
  setDeafenedRef: (deafened: boolean) => void
  applyRemoteAudio: (deafened: boolean) => void
  applyVoiceDevices: (room: Room) => Promise<void>
  applyMicProcessing: (participant: Room['localParticipant']) => Promise<unknown>
  syncLocalSpeakingTrack: (room: Room) => void
  syncRoomParticipants: () => void
  getUserId: () => string | null
  hasNativeMicrophonePublishing: () => boolean
  patchLocalVoiceDeafen: (
    channelId: string,
    userId: string,
    deafened: boolean,
  ) => void
  syncVoiceFlagsToGateway: (
    channelId: string,
    selfMute: boolean,
    selfDeaf: boolean,
  ) => void
  setLocalVoiceReady: (ready: boolean) => void
}

export async function switchDeviceWithTimeout(
  room: Room,
  kind: 'audioinput' | 'audiooutput',
  deviceId: string,
) {
  await Promise.race([
    room.switchActiveDevice(kind, deviceId).catch(() => {}),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, DEVICE_SWITCH_TIMEOUT_MS)
    }),
  ])
}

export function readCurrentVoiceFlags(options: CurrentVoiceFlagsOptions) {
  const selfDeaf = options.selfDeaf
  if (selfDeaf || options.selfMonitoringActive) {
    return { selfMute: true, selfDeaf }
  }
  if (options.room) {
    if (options.shouldUseNativeMicrophone) {
      return {
        selfMute: !options.hasNativeMicrophone || options.nativeMicrophoneMuted,
        selfDeaf,
      }
    }
    return {
      selfMute: !participantMicPublishing(options.room.localParticipant),
      selfDeaf,
    }
  }
  return { selfMute: !options.fallbackMicPublishing, selfDeaf }
}

export function restoreVoicePreferences(deps: RestoreVoicePreferencesDeps) {
  const prefs = deps.readPreferences()
  deps.setMicEnabled(prefs.micEnabled)
  deps.setMicPublishing(prefs.micEnabled)
  deps.setCurrentMicIssue(null)
  deps.setDeafened(prefs.deafened)
  deps.setDeafenedRef(prefs.deafened)
}

export async function applyVoiceDevices(deps: ApplyVoiceDevicesDeps) {
  const prefs = deps.readPreferences()
  if (prefs.preferredAudioInputDevice && !deps.shouldUseNativeMicrophone) {
    await switchDeviceWithTimeout(
      deps.room,
      'audioinput',
      prefs.preferredAudioInputDevice,
    )
  }
  if (prefs.preferredAudioOutputDevice) {
    await switchDeviceWithTimeout(
      deps.room,
      'audiooutput',
      prefs.preferredAudioOutputDevice,
    )
  }
  deps.setRemoteAudioOutputDevice(prefs.preferredAudioOutputDevice)
  deps.applyRemoteAudio(deps.isDeafened())
}

export function syncMicFromRoom(deps: SyncMicFromRoomDeps) {
  const publishing = participantMicPublishing(deps.room.localParticipant)
  const effectivePublishing =
    deps.shouldUseNativeMicrophone && deps.hasNativeMicrophone
      ? !deps.nativeMicrophoneMuted
      : publishing

  deps.setMicPublishing(effectivePublishing)

  if (
    shouldResetMicPreferenceOnIssue({
      wantsMic: deps.wantsMic,
      micPublishing: effectivePublishing,
      micIssue: deps.issue ?? null,
    })
  ) {
    deps.resetMicPreference(false)
    deps.setMicEnabled(false)
  }

  if (deps.issue !== undefined) {
    deps.setCurrentMicIssue(deps.issue, deps.issue != null)
  } else if (effectivePublishing) {
    deps.setCurrentMicIssue(null)
  } else if (deps.wantsMic) {
    const fallbackIssue = deps.currentMicIssue ?? deps.fallbackIssue
    if (
      shouldResetMicPreferenceOnIssue({
        wantsMic: deps.wantsMic,
        micPublishing: effectivePublishing,
        micIssue: fallbackIssue,
      })
    ) {
      deps.resetMicPreference(false)
      deps.setMicEnabled(false)
    }
    deps.setCurrentMicIssue(fallbackIssue, true)
  } else {
    deps.setCurrentMicIssue(null)
  }

  if (deps.activeChannelId && deps.userId) {
    deps.patchLocalVoiceMic(
      deps.activeChannelId,
      deps.userId,
      effectivePublishing,
    )
  }
}

export async function finishLocalVoiceSetup(deps: FinishLocalVoiceSetupDeps) {
  const { room, targetChannelId } = deps
  if (!deps.isCurrentVoiceSession(room, targetChannelId)) {
    return
  }
  const prefs = deps.readPreferences()
  const suppressedBySelfMonitoring =
    deps.selfMonitoringActive && prefs.micEnabled
  let micSetupFailed = false
  try {
    if (deps.shouldUseNativeMicrophone) {
      const nativeStarted = await deps.startNativeMicrophone(
        room,
        !prefs.micEnabled || suppressedBySelfMonitoring || prefs.deafened,
      )
      if (!nativeStarted || !deps.isCurrentVoiceSession(room, targetChannelId)) {
        return
      }
    } else {
      await room.localParticipant.setMicrophoneEnabled(
        prefs.micEnabled && !suppressedBySelfMonitoring,
        undefined,
        deps.voiceMicPublishOptions(deps.activeChannelAudioBitrateKbps()),
      )
      if (!deps.isCurrentVoiceSession(room, targetChannelId)) {
        return
      }
    }
  } catch (error) {
    if (!deps.isCurrentVoiceSession(room, targetChannelId)) {
      return
    }
    micSetupFailed = true
    const issue = deps.describeMicDeviceError(error)
    deps.syncMicFromRoom(
      room,
      deps.shouldUseNativeMicrophone
        ? { ...issue, retryable: true }
        : issue,
    )
  }

  deps.setMicEnabled(deps.getMicEnabledPreference())
  if (suppressedBySelfMonitoring) {
    deps.setSelfMonitoringRestorePublishing(true)
    deps.setMicPublishing(false)
    deps.setCurrentMicIssue(null)
  } else if (!micSetupFailed) {
    deps.syncMicFromRoom(room)
  }
  deps.setDeafened(prefs.deafened)
  deps.setDeafenedRef(prefs.deafened)
  deps.applyRemoteAudio(prefs.deafened)
  await deps.applyVoiceDevices(room)
  if (!deps.isCurrentVoiceSession(room, targetChannelId)) {
    return
  }
  if (
    prefs.micEnabled &&
    !suppressedBySelfMonitoring &&
    !micSetupFailed &&
    !deps.shouldUseNativeMicrophone
  ) {
    await deps.applyMicProcessing(room.localParticipant)
    if (!deps.isCurrentVoiceSession(room, targetChannelId)) {
      return
    }
  }
  deps.syncLocalSpeakingTrack(room)
  deps.syncRoomParticipants()

  if (!deps.isCurrentVoiceSession(room, targetChannelId)) {
    return
  }
  const userId = deps.getUserId()
  if (userId) {
    const nextMicPublishing = suppressedBySelfMonitoring
      ? false
      : deps.shouldUseNativeMicrophone
        ? deps.hasNativeMicrophonePublishing()
        : participantMicPublishing(room.localParticipant)
    deps.patchLocalVoiceDeafen(targetChannelId, userId, prefs.deafened)
    deps.syncVoiceFlagsToGateway(
      targetChannelId,
      !nextMicPublishing,
      prefs.deafened,
    )
  }
  if (!deps.isCurrentVoiceSession(room, targetChannelId)) {
    return
  }
  deps.setLocalVoiceReady(true)
  deps.setConnectionPhase('connected')
}
