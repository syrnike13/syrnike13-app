import { describe, expect, it } from 'vitest'

import {
  clearMediaEngineRemoteVideo,
  getMediaEngineRemoteVideoFrame,
  hasMediaEngineRemoteVideoFrame,
  updateMediaEngineRemoteVideoFrame,
} from '#/features/voice/media-engine-remote-video'

describe('media-engine-remote-video', () => {
  it('stores and clears remote video frames by user and source', () => {
    updateMediaEngineRemoteVideoFrame('user-1', 'screen', 'abc', 1920, 1080)

    expect(hasMediaEngineRemoteVideoFrame('user-1', 'screen')).toBe(true)
    expect(getMediaEngineRemoteVideoFrame('user-1', 'screen')).toEqual({
      jpegDataUrl: 'data:image/jpeg;base64,abc',
      width: 1920,
      height: 1080,
    })

    clearMediaEngineRemoteVideo('user-1', 'screen')
    expect(hasMediaEngineRemoteVideoFrame('user-1', 'screen')).toBe(false)
  })
})
