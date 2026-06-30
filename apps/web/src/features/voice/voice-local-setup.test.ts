/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { Track } from 'livekit-client'
import type { Room } from 'livekit-client'

import {
  applyVoiceDevices,
  finishLocalVoiceSetup,
  readCurrentVoiceFlags,
  restoreVoicePreferences,
  syncMicFromRoom,
  switchDeviceWithTimeout,
} from '#/features/voice/voice-local-setup'
import type { VoiceMicIssue } from '#/features/voice/voice-mic-status'

function roomWithMicPublishing(publishing: boolean): Room {
  return {
    localParticipant: {
      isMicrophoneEnabled: publishing,
      trackPublications: new Map(
        publishing
          ? [
              [
                'mic',
                {
                  kind: Track.Kind.Audio,
                  source: Track.Source.Microphone,
                  isMuted: false,
                  track: {},
                },
              ],
            ]
          : [],
      ),
    },
  } as unknown as Room
}

describe('voice local setup helpers', () => {
  it('switches the requested LiveKit device', async () => {
    const room = {
      switchActiveDevice: vi.fn(async () => {}),
    } as unknown as Room

    await switchDeviceWithTimeout(room, 'audioinput', 'mic-1')

    expect(room.switchActiveDevice).toHaveBeenCalledWith('audioinput', 'mic-1')
  })

  it('swallows LiveKit device switch failures', async () => {
    const room = {
      switchActiveDevice: vi.fn(async () => {
        throw new Error('device unavailable')
      }),
    } as unknown as Room

    await expect(
      switchDeviceWithTimeout(room, 'audiooutput', 'speaker-1'),
    ).resolves.toBeUndefined()
  })

  it('forces self mute while deafened or self monitoring', () => {
    expect(
      readCurrentVoiceFlags({
        room: null,
        selfDeaf: true,
        selfMonitoringActive: false,
        shouldUseNativeMicrophone: false,
        hasNativeMicrophone: false,
        nativeMicrophoneMuted: false,
        fallbackMicPublishing: true,
      }),
    ).toEqual({ selfMute: true, selfDeaf: true })

    expect(
      readCurrentVoiceFlags({
        room: null,
        selfDeaf: false,
        selfMonitoringActive: true,
        shouldUseNativeMicrophone: false,
        hasNativeMicrophone: false,
        nativeMicrophoneMuted: false,
        fallbackMicPublishing: true,
      }),
    ).toEqual({ selfMute: true, selfDeaf: false })
  })

  it('reads native microphone mute state when native mic is active', () => {
    expect(
      readCurrentVoiceFlags({
        room: {} as Room,
        selfDeaf: false,
        selfMonitoringActive: false,
        shouldUseNativeMicrophone: true,
        hasNativeMicrophone: true,
        nativeMicrophoneMuted: false,
        fallbackMicPublishing: false,
      }),
    ).toEqual({ selfMute: false, selfDeaf: false })

    expect(
      readCurrentVoiceFlags({
        room: {} as Room,
        selfDeaf: false,
        selfMonitoringActive: false,
        shouldUseNativeMicrophone: true,
        hasNativeMicrophone: true,
        nativeMicrophoneMuted: true,
        fallbackMicPublishing: false,
      }),
    ).toEqual({ selfMute: true, selfDeaf: false })
  })

  it('restores saved voice preferences into UI state and refs', () => {
    const setMicEnabled = vi.fn()
    const setMicPublishing = vi.fn()
    const setCurrentMicIssue = vi.fn()
    const setDeafened = vi.fn()
    const setDeafenedRef = vi.fn()

    restoreVoicePreferences({
      readPreferences: () => ({ micEnabled: false, deafened: true }),
      setMicEnabled,
      setMicPublishing,
      setCurrentMicIssue,
      setDeafened,
      setDeafenedRef,
    })

    expect(setMicEnabled).toHaveBeenCalledWith(false)
    expect(setMicPublishing).toHaveBeenCalledWith(false)
    expect(setCurrentMicIssue).toHaveBeenCalledWith(null)
    expect(setDeafened).toHaveBeenCalledWith(true)
    expect(setDeafenedRef).toHaveBeenCalledWith(true)
  })

  it('applies preferred output device and remote audio state', async () => {
    const room = {
      switchActiveDevice: vi.fn(async () => {}),
    } as unknown as Room
    const setRemoteAudioOutputDevice = vi.fn()
    const applyRemoteAudio = vi.fn()

    await applyVoiceDevices({
      room,
      readPreferences: () => ({
        micEnabled: true,
        deafened: false,
        preferredAudioInputDevice: 'mic-1',
        preferredAudioOutputDevice: 'speaker-1',
      }),
      shouldUseNativeMicrophone: true,
      setRemoteAudioOutputDevice,
      applyRemoteAudio,
      isDeafened: () => true,
    })

    expect(room.switchActiveDevice).toHaveBeenCalledTimes(1)
    expect(room.switchActiveDevice).toHaveBeenCalledWith(
      'audiooutput',
      'speaker-1',
    )
    expect(setRemoteAudioOutputDevice).toHaveBeenCalledWith('speaker-1')
    expect(applyRemoteAudio).toHaveBeenCalledWith(true)
  })

  it('syncs browser mic publishing and clears stale mic issues', () => {
    const setMicPublishing = vi.fn()
    const setCurrentMicIssue = vi.fn()
    const patchLocalVoiceMic = vi.fn()

    syncMicFromRoom({
      room: roomWithMicPublishing(true),
      issue: undefined,
      wantsMic: true,
      shouldUseNativeMicrophone: false,
      hasNativeMicrophone: false,
      nativeMicrophoneMuted: false,
      activeChannelId: 'voice-a',
      userId: 'user-1',
      currentMicIssue: null,
      fallbackIssue: { label: 'fallback', hint: 'fallback' },
      setMicPublishing,
      resetMicPreference: vi.fn(),
      setMicEnabled: vi.fn(),
      setCurrentMicIssue,
      patchLocalVoiceMic,
    })

    expect(setMicPublishing).toHaveBeenCalledWith(true)
    expect(setCurrentMicIssue).toHaveBeenCalledWith(null)
    expect(patchLocalVoiceMic).toHaveBeenCalledWith('voice-a', 'user-1', true)
  })

  it('resets mic preference when an explicit issue blocks wanted mic publishing', () => {
    const issue: VoiceMicIssue = { label: 'No mic', hint: 'Blocked' }
    const resetMicPreference = vi.fn()
    const setMicEnabled = vi.fn()
    const setCurrentMicIssue = vi.fn()

    syncMicFromRoom({
      room: roomWithMicPublishing(false),
      issue,
      wantsMic: true,
      shouldUseNativeMicrophone: false,
      hasNativeMicrophone: false,
      nativeMicrophoneMuted: false,
      activeChannelId: null,
      userId: 'user-1',
      currentMicIssue: null,
      fallbackIssue: { label: 'fallback', hint: 'fallback' },
      setMicPublishing: vi.fn(),
      resetMicPreference,
      setMicEnabled,
      setCurrentMicIssue,
      patchLocalVoiceMic: vi.fn(),
    })

    expect(resetMicPreference).toHaveBeenCalledWith(false)
    expect(setMicEnabled).toHaveBeenCalledWith(false)
    expect(setCurrentMicIssue).toHaveBeenCalledWith(issue, true)
  })

  it('uses a fallback issue when wanted mic is not publishing without an explicit issue', () => {
    const fallbackIssue: VoiceMicIssue = {
      label: 'Mic blocked',
      hint: 'Browser did not publish mic',
    }
    const setCurrentMicIssue = vi.fn()

    syncMicFromRoom({
      room: roomWithMicPublishing(false),
      issue: undefined,
      wantsMic: true,
      shouldUseNativeMicrophone: false,
      hasNativeMicrophone: false,
      nativeMicrophoneMuted: false,
      activeChannelId: null,
      userId: 'user-1',
      currentMicIssue: null,
      fallbackIssue,
      setMicPublishing: vi.fn(),
      resetMicPreference: vi.fn(),
      setMicEnabled: vi.fn(),
      setCurrentMicIssue,
      patchLocalVoiceMic: vi.fn(),
    })

    expect(setCurrentMicIssue).toHaveBeenCalledWith(fallbackIssue, true)
  })

  it('finishes browser local voice setup and publishes voice flags', async () => {
    const room = {
      localParticipant: {
        setMicrophoneEnabled: vi.fn(async () => {}),
        trackPublications: new Map([
          [
            'mic',
            {
              kind: Track.Kind.Audio,
              source: Track.Source.Microphone,
              isMuted: false,
              track: {},
            },
          ],
        ]),
      },
    } as unknown as Room
    const setConnectionPhase = vi.fn()
    const syncMicFromRoom = vi.fn()
    const applyVoiceDevices = vi.fn(async () => {})
    const applyMicProcessing = vi.fn(async () => {})
    const syncVoiceFlagsToGateway = vi.fn()
    const setLocalVoiceReady = vi.fn()

    await finishLocalVoiceSetup({
      room,
      targetChannelId: 'voice-a',
      isCurrentVoiceSession: () => true,
      readPreferences: () => ({ micEnabled: true, deafened: false }),
      getMicEnabledPreference: () => true,
      selfMonitoringActive: false,
      setSelfMonitoringRestorePublishing: vi.fn(),
      shouldUseNativeMicrophone: false,
      startNativeMicrophone: vi.fn(),
      voiceMicPublishOptions: () => ({}) as never,
      activeChannelAudioBitrateKbps: () => 64,
      describeMicDeviceError: () => ({ label: 'Mic', hint: 'Mic failed' }),
      setConnectionPhase,
      syncMicFromRoom,
      setMicEnabled: vi.fn(),
      setMicPublishing: vi.fn(),
      setCurrentMicIssue: vi.fn(),
      setDeafened: vi.fn(),
      setDeafenedRef: vi.fn(),
      applyRemoteAudio: vi.fn(),
      applyVoiceDevices,
      applyMicProcessing,
      syncLocalSpeakingTrack: vi.fn(),
      syncRoomParticipants: vi.fn(),
      getUserId: () => 'user-1',
      hasNativeMicrophonePublishing: () => false,
      patchLocalVoiceDeafen: vi.fn(),
      syncVoiceFlagsToGateway,
      setLocalVoiceReady,
    })

    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
      true,
      undefined,
      {},
    )
    expect(applyMicProcessing).toHaveBeenCalledWith(room.localParticipant)
    expect(syncMicFromRoom).toHaveBeenCalledWith(room)
    expect(applyVoiceDevices).toHaveBeenCalledWith(room)
    expect(syncVoiceFlagsToGateway).toHaveBeenCalledWith(
      'voice-a',
      false,
      false,
    )
    expect(setLocalVoiceReady).toHaveBeenCalledWith(true)
    expect(setConnectionPhase).toHaveBeenCalledWith('connected')
  })
})
