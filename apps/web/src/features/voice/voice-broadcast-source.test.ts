import { describe, expect, it } from 'vitest'
import { createTranslator } from '@syrnike13/ui/i18n'

import {
  AppWindowIcon,
  GlobeIcon,
  MonitorIcon,
  VideoIcon,
} from '#/components/icons'
import ru from '#/messages/ru.json'
import {
  cameraBroadcastIcon,
  parseScreenShareSurface,
  readDesktopScreenShareBroadcastSource,
  readCameraBroadcastLabel,
  readScreenShareBroadcastSource,
  screenShareBroadcastIcon,
  screenShareBroadcastLabel,
  screenShareSurfaceFallbackLabel,
  rememberDesktopScreenShareBroadcastSource,
} from '#/features/voice/voice-broadcast-source'

const t = createTranslator(ru, 'ru', 'voice')

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
    expect(screenShareSurfaceFallbackLabel('monitor', t)).toBe('Экран')
    expect(screenShareSurfaceFallbackLabel('window', t)).toBe('Окно')
    expect(screenShareSurfaceFallbackLabel('browser', t)).toBe(
      'Вкладка браузера',
    )
  })
})

describe('screenShareBroadcastLabel', () => {
  it('formats internal and numbered screen labels', () => {
    expect(screenShareBroadcastLabel('screen:0', 'monitor', t)).toBe('Экран 1')
    expect(screenShareBroadcastLabel('screen:2', 'monitor', t)).toBe('Экран 3')
    expect(screenShareBroadcastLabel('Screen 2 (1920x1080)', 'monitor', t)).toBe(
      'Экран 2',
    )
    expect(screenShareBroadcastLabel('window:12:0', 'window', t)).toBe('Окно')
  })

  it('falls back to a surface label for empty names', () => {
    expect(screenShareBroadcastLabel('', 'monitor', t)).toBe('Экран')
    expect(screenShareBroadcastLabel('   ', 'browser', t)).toBe(
      'Вкладка браузера',
    )
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

  it('keeps empty labels and resolves them at render time', () => {
    expect(
      readScreenShareBroadcastSource({
        label: '',
        getSettings: () => ({ displaySurface: 'monitor' }),
      } as MediaStreamTrack),
    ).toEqual({
      label: '',
      surface: 'monitor',
    })
  })

  it('falls back to the window surface when track settings are unavailable', () => {
    expect(
      readScreenShareBroadcastSource({
        label: '   ',
      } as MediaStreamTrack),
    ).toEqual({
      label: '',
      surface: 'window',
    })

    expect(
      readScreenShareBroadcastSource({
        label: '',
        getSettings: () => undefined as unknown as MediaTrackSettings,
      } as MediaStreamTrack),
    ).toEqual({
      label: '',
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

    const source = readDesktopScreenShareBroadcastSource()
    expect(source?.surface).toBe('monitor')
    expect(
      screenShareBroadcastLabel(source?.label, source?.surface ?? 'monitor', t),
    ).toBe('Экран 2')
  })

  it('maps game and window sources to window surfaces', () => {
    rememberDesktopScreenShareBroadcastSource({ name: 'Game', type: 'game' })
    expect(readDesktopScreenShareBroadcastSource()?.surface).toBe('window')

    rememberDesktopScreenShareBroadcastSource({
      name: '  ',
      type: 'window',
    })
    const source = readDesktopScreenShareBroadcastSource()
    expect(source?.surface).toBe('window')
    expect(
      screenShareBroadcastLabel(source?.label, source?.surface ?? 'window', t),
    ).toBe('Окно')
  })
})

describe('readCameraBroadcastLabel', () => {
  it('uses the device label when available', () => {
    expect(
      readCameraBroadcastLabel(
        {
          label: 'FaceTime HD Camera',
        } as MediaStreamTrack,
        t,
      ),
    ).toBe('FaceTime HD Camera')
  })

  it('falls back when the device label is blank or missing', () => {
    expect(
      readCameraBroadcastLabel({ label: '   ' } as MediaStreamTrack, t),
    ).toBe('Камера')
    expect(readCameraBroadcastLabel(null, t)).toBe('Камера')
  })
})

describe('cameraBroadcastIcon', () => {
  it('returns the camera icon', () => {
    expect(cameraBroadcastIcon()).toBe(VideoIcon)
  })
})
