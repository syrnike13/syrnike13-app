import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@syrnike13/ui/i18n'

import ru from '#/messages/ru.json'
import { getSyrnikeDesktop } from '#/platform/runtime'

import {
  buildVoiceMediaAvailabilityState,
  hasDetectedMediaDevices,
  microphoneMediaControlState,
  resolveCameraAvailability,
  resolveMicrophoneAvailability,
  resolveScreenShareAvailability,
  voiceMediaControlState,
} from './voice-media-availability'

const t = createTranslator(ru, 'ru', 'voice.media')

vi.mock('#/platform/runtime', () => ({
  getSyrnikeDesktop: vi.fn(() => null),
}))

vi.mock('#/features/voice/native-microphone-publish', () => ({
  shouldUseNativeMicrophone: vi.fn(() => false),
}))

describe('voice media availability', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
        getDisplayMedia: vi.fn(),
      },
    })
  })

  it('treats empty device lists as unavailable', () => {
    expect(hasDetectedMediaDevices([])).toBe(false)
    expect(
      resolveMicrophoneAvailability(
        { inputDevices: [], micIssue: null },
        t,
      ).available,
    ).toBe(false)
    expect(resolveCameraAvailability({ videoDevices: [] }, t).title).toBe(
      'Камера недоступна',
    )
  })

  it('marks microphone unavailable when runtime mic issue exists', () => {
    const availability = resolveMicrophoneAvailability(
      {
        inputDevices: [
          { deviceId: 'mic', kind: 'audioinput' } as MediaDeviceInfo,
        ],
        micIssue: {
          label: 'Микрофон занят',
          hint: 'Закройте другие программы.',
        },
      },
      t,
    )

    expect(availability.available).toBe(false)
    expect(availability.title).toBe('Микрофон недоступен')
  })

  it('blocks enabling controls only while media is off', () => {
    const availability = resolveCameraAvailability(
      {
        videoDevices: [],
      },
      t,
    )

    expect(
      voiceMediaControlState({
        availability,
        active: false,
        inactiveTitle: 'Включить камеру',
        activeTitle: 'Выключить камеру',
      }),
    ).toEqual({
      disabled: true,
      title: 'Камера недоступна',
    })

    expect(
      voiceMediaControlState({
        availability,
        active: true,
        inactiveTitle: 'Включить камеру',
        activeTitle: 'Выключить камеру',
      }).disabled,
    ).toBe(false)
  })

  it('blocks unmuting when microphone is unavailable', () => {
    const state = microphoneMediaControlState(
      {
        availability: resolveMicrophoneAvailability(
          {
            inputDevices: [],
            micIssue: null,
          },
          t,
        ),
        inVoice: true,
        micMuted: true,
      },
      t,
    )

    expect(state.disabled).toBe(true)
    expect(state.title).toBe('Микрофон недоступен')
  })

  it('uses native screen share bridge on Windows desktop', () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: { openDisplayPicker: vi.fn() },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    expect(resolveScreenShareAvailability(t).available).toBe(true)
  })

  it('builds a full availability snapshot', () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue(null)

    const state = buildVoiceMediaAvailabilityState(
      {
        inputDevices: [
          { deviceId: 'mic', kind: 'audioinput' } as MediaDeviceInfo,
        ],
        videoDevices: [
          { deviceId: 'cam', kind: 'videoinput' } as MediaDeviceInfo,
        ],
        micIssue: null,
      },
      t,
    )

    expect(state.microphone.available).toBe(true)
    expect(state.camera.available).toBe(true)
    expect(state.screenShare.available).toBe(true)
  })
})
