import { describe, expect, it } from 'vitest'

import { IPC } from './ipc'

describe('desktop media IPC contract', () => {
  it('uses a generic media session start channel', () => {
    expect(IPC.mediaStartSession).toBe('syrnike-desktop:media:start-session')
    expect('mediaStartScreenShare' in IPC).toBe(false)
  })

  it('exposes native media device enumeration through the media namespace', () => {
    expect(IPC.mediaListDevices).toBe('syrnike-desktop:media:list-devices')
  })

  it('exposes native microphone mute through the media namespace', () => {
    expect(IPC.mediaSetMicrophoneMuted).toBe(
      'syrnike-desktop:media:set-microphone-muted',
    )
  })

  it('does not expose out-of-band media audio preparation channels', () => {
    expect('mediaPrepareSystemAudio' in IPC).toBe(false)
    expect('mediaClearSystemAudio' in IPC).toBe(false)
  })
})

describe('desktop tray IPC contract', () => {
  it('exposes voice state through the tray namespace', () => {
    expect(IPC.traySetVoiceState).toBe(
      'syrnike-desktop:tray:set-voice-state',
    )
  })
})
