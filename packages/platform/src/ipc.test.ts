import { describe, expect, it } from 'vitest'

import { IPC } from './ipc'

describe('desktop IPC contract', () => {
  it('keeps support channels without legacy lifecycle channels', () => {
    expect(IPC.mediaStartMicrophonePreview).toBe('syrnike-desktop:media:start-microphone-preview')
    expect(IPC.mediaSetRemoteVideoDemand).toBe('syrnike-desktop:media:set-remote-video-demand')
    expect(IPC).not.toHaveProperty('mediaApplyLocalMediaIntent')
    expect(IPC).not.toHaveProperty('mediaConfigureMicrophonePipeline')
    expect(IPC).not.toHaveProperty('mediaGetState')
    expect(IPC).not.toHaveProperty('mediaStats')
    expect(IPC).not.toHaveProperty('mediaLocalMediaState')
  })
})
