import { describe, expect, it } from 'vitest'

import {
  readCameraBroadcastLabel,
  readScreenShareBroadcastSource,
  screenShareSurfaceFallbackLabel,
} from '#/features/voice/voice-broadcast-source'

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
})

describe('readCameraBroadcastLabel', () => {
  it('uses the device label when available', () => {
    expect(
      readCameraBroadcastLabel({
        label: 'FaceTime HD Camera',
      } as MediaStreamTrack),
    ).toBe('FaceTime HD Camera')
  })
})
