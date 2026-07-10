import { describe, expect, it } from 'vitest'

import { IPC } from './ipc'

describe('desktop media IPC contract', () => {
  it('uses one declarative local-media intent channel', () => {
    expect(IPC.mediaApplyLocalMediaIntent).toBe(
      'syrnike-desktop:media:apply-local-media-intent',
    )
    expect(IPC.mediaLocalMediaState).toBe(
      'syrnike-desktop:media:local-media-state',
    )
  })

  it('exposes native media device enumeration through the media namespace', () => {
    expect(IPC.mediaListDevices).toBe('syrnike-desktop:media:list-devices')
  })

  it('does not expose imperative publication channels', () => {
    expect('mediaPrepareScreenSession' in IPC).toBe(false)
    expect('mediaDisconnectPreparedScreenSession' in IPC).toBe(false)
    expect('mediaStartSession' in IPC).toBe(false)
    expect('mediaCancelPendingStarts' in IPC).toBe(false)
    expect('mediaSetMicrophoneMuted' in IPC).toBe(false)
    expect('mediaReconnectMicrophoneSession' in IPC).toBe(false)
    expect('mediaStopSession' in IPC).toBe(false)
    expect('mediaStateChanged' in IPC).toBe(false)
    expect('mediaStreamEnded' in IPC).toBe(false)
    expect('mediaStreamError' in IPC).toBe(false)
    expect('mediaRuntimeLost' in IPC).toBe(false)
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

describe('desktop clipboard IPC contract', () => {
  it('exposes clipboard text writes through the clipboard namespace', () => {
    expect(IPC.clipboardWriteText).toBe(
      'syrnike-desktop:clipboard:write-text',
    )
  })
})
