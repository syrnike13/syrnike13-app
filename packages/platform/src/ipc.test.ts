import { describe, expect, it } from 'vitest'

import { IPC } from './ipc'

describe('desktop media IPC contract', () => {
  it('uses a generic media session start channel', () => {
    expect(IPC.mediaStartSession).toBe('syrnike-desktop:media:start-session')
    expect('mediaStartScreenShare' in IPC).toBe(false)
  })

  it('does not expose out-of-band media audio preparation channels', () => {
    expect('mediaPrepareSystemAudio' in IPC).toBe(false)
    expect('mediaClearSystemAudio' in IPC).toBe(false)
  })
})
