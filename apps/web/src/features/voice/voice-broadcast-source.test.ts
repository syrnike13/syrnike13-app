import { describe, expect, it } from 'vitest'

import {
  AppWindowIcon,
  GlobeIcon,
  MonitorIcon,
  VideoIcon,
} from '#/components/icons'
import {
  cameraBroadcastIcon,
  parseScreenShareSurface,
  readDesktopScreenShareBroadcastSource,
  readCameraBroadcastLabel,
  readScreenShareBroadcastSource,
  screenShareBroadcastIcon,
  screenShareSurfaceFallbackLabel,
  rememberDesktopScreenShareBroadcastSource,
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
    expect(screenShareBroadcastIcon('monitor')).toBe(MonitorIcon)
    expect(screenShareBroadcastIcon('window')).toBe(AppWindowIcon)
    expect(screenShareBroadcastIcon('browser')).toBe(GlobeIcon)
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

describe('desktop screen-share source', () => {
  it('remembers screens as monitor surfaces', () => {
    rememberDesktopScreenShareBroadcastSource({
      name: 'Screen 2 (1920x1080)',
      type: 'screen',
    })

    expect(readDesktopScreenShareBroadcastSource()).toEqual({
      label: 'Screen 2 (1920x1080)',
      surface: 'monitor',
    })
  })

  it('maps game and window sources to window surfaces', () => {
    rememberDesktopScreenShareBroadcastSource({ name: 'Game', type: 'game' })
    expect(readDesktopScreenShareBroadcastSource()?.surface).toBe('window')

    rememberDesktopScreenShareBroadcastSource({
      name: '  ',
      type: 'window',
    })
    expect(readDesktopScreenShareBroadcastSource()).toEqual({
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
    expect(cameraBroadcastIcon()).toBe(VideoIcon)
  })
})
