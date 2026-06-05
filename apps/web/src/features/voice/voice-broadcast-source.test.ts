import { describe, expect, it } from 'vitest'

import {
  cameraBroadcastIcon,
  parseScreenShareSurface,
  readCameraBroadcastLabel,
  readScreenShareBroadcastSource,
  screenShareBroadcastIcon,
  screenShareSurfaceFallbackLabel,
} from '#/features/voice/voice-broadcast-source'

describe('parseScreenShareSurface', () => {
  it('keeps valid browser surface values', () => {
    expect(parseScreenShareSurface('monitor')).toBe('monitor')
    expect(parseScreenShareSurface('window')).toBe('window')
    expect(parseScreenShareSurface('browser')).toBe('browser')
  })

  it('falls back to window for invalid values', () => {
    expect(parseScreenShareSurface(undefined)).toBe('window')
    expect(parseScreenShareSurface(null as unknown as undefined)).toBe('window')
    expect(parseScreenShareSurface('')).toBe('window')
    expect(parseScreenShareSurface('  ')).toBe('window')
    expect(parseScreenShareSurface('unknown')).toBe('window')
  })
})

describe('screenShareSurfaceFallbackLabel', () => {
  it('returns a label for each supported surface', () => {
    expect(screenShareSurfaceFallbackLabel('monitor')).toBe('Весь экран')
    expect(screenShareSurfaceFallbackLabel('window')).toBe('Окно')
    expect(screenShareSurfaceFallbackLabel('browser')).toBe('Вкладка браузера')
  })
})

describe('screenShareBroadcastIcon', () => {
  it('returns an icon for each supported surface', () => {
    expect(screenShareBroadcastIcon('monitor').displayName).toBe('Monitor')
    expect(screenShareBroadcastIcon('window').displayName).toBe('AppWindow')
    expect(screenShareBroadcastIcon('browser').displayName).toBe('Globe')
  })
})

describe('readScreenShareBroadcastSource', () => {
  it('uses the track label when the browser provides one', () => {
    expect(
      readScreenShareBroadcastSource({
        label: 'Google Chrome',
        getSettings: () => ({ displaySurface: 'browser' }),
      } as MediaStreamTrack).label,
    ).toBe('Google Chrome')
  })

  it('falls back to a surface label when track label is empty', () => {
    expect(
      readScreenShareBroadcastSource({
        label: '',
        getSettings: () => ({ displaySurface: 'monitor' }),
      } as MediaStreamTrack),
    ).toEqual({
      label: screenShareSurfaceFallbackLabel('monitor'),
      surface: 'monitor',
    })
  })

  it('falls back when track settings are unavailable', () => {
    expect(
      readScreenShareBroadcastSource({
        label: '   ',
      } as MediaStreamTrack),
    ).toEqual({
      label: screenShareSurfaceFallbackLabel('window'),
      surface: 'window',
    })

    expect(
      readScreenShareBroadcastSource({
        label: '',
        getSettings: () => undefined as unknown as MediaTrackSettings,
      } as MediaStreamTrack),
    ).toEqual({
      label: screenShareSurfaceFallbackLabel('window'),
      surface: 'window',
    })
  })
})

describe('readCameraBroadcastLabel', () => {
  it('uses the device label when available', () => {
    expect(
      readCameraBroadcastLabel({
        label: 'FaceTime HD Camera',
      } as MediaStreamTrack),
    ).toBe('FaceTime HD Camera')
  })

  it('falls back when the device label is blank or missing', () => {
    expect(readCameraBroadcastLabel({ label: '   ' } as MediaStreamTrack)).toBe(
      'Камера',
    )
    expect(readCameraBroadcastLabel(null)).toBe('Камера')
  })
})

describe('cameraBroadcastIcon', () => {
  it('returns the camera icon', () => {
    expect(cameraBroadcastIcon().displayName).toBe('Video')
  })
})
