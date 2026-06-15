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

  it('exposes desktop music presence through its own namespace', () => {
    expect(IPC.musicGetCurrentPresence).toBe(
      'syrnike-desktop:music:get-current-presence',
    )
    expect(IPC.musicPresenceChanged).toBe(
      'syrnike-desktop:music:presence-changed',
    )
  })
})
