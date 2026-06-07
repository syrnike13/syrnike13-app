import { describe, expect, it } from 'vitest'

import {
  normalizeDeviceLabel,
  reconcilePreferredDeviceId,
} from './voice-audio-devices'

describe('voice-audio-devices', () => {
  const devices = [
    { id: '{wasapi-in-1}', label: 'Microphone (USB Audio)' },
    { id: '{wasapi-in-2}', label: 'Headset Microphone' },
  ]

  it('keeps stored id when it exists in the engine list', () => {
    expect(
      reconcilePreferredDeviceId('{wasapi-in-1}', devices, 'ignored'),
    ).toBe('{wasapi-in-1}')
  })

  it('matches engine device by browser label', () => {
    expect(
      reconcilePreferredDeviceId(
        'browser-device-id',
        devices,
        'Microphone (USB Audio)',
      ),
    ).toBe('{wasapi-in-1}')
  })

  it('returns undefined when no match is found', () => {
    expect(
      reconcilePreferredDeviceId('browser-device-id', devices, 'Unknown mic'),
    ).toBeUndefined()
  })

  it('normalizes labels for comparison', () => {
    expect(normalizeDeviceLabel('  Headset Microphone  ')).toBe(
      'headset microphone',
    )
  })
})
