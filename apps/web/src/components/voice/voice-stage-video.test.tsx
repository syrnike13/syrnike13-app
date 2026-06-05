// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStageVideo } from '#/components/voice/voice-stage-video'

function videoTrackStub(trackSid = 'TR_screen') {
  const track = {
    sid: trackSid,
    mediaStreamTrack: {},
    attach: vi.fn(),
    detach: vi.fn(),
  }

  return { track }
}

describe('VoiceStageVideo', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'MediaStream',
      vi.fn(function MediaStreamStub(this: { tracks: unknown[] }, tracks) {
        this.tracks = tracks
      }),
    )
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn(() => Promise.resolve()),
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: vi.fn(),
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renders the media stream track without LiveKit attach/detach churn', () => {
    const { track } = videoTrackStub()

    const first = render(
      <VoiceStageVideo
        mediaId="remote-user:screen"
        track={track as unknown as Parameters<typeof VoiceStageVideo>[0]['track']}
      />,
    )

    const element = document.querySelector('video')!
    expect(track.attach).not.toHaveBeenCalled()
    expect(element.isConnected).toBe(true)
    expect(element.srcObject).toBeInstanceOf(MediaStream)

    first.unmount()

    expect(track.detach).not.toHaveBeenCalled()
    expect(element.srcObject).toBe(null)
  })

  it('creates video elements in the current host document', () => {
    const { track } = videoTrackStub()
    const popoutDocument = document.implementation.createHTMLDocument('popout')
    const host = popoutDocument.createElement('div')
    popoutDocument.body.appendChild(host)

    render(
      <VoiceStageVideo
        mediaId="remote-user:screen"
        track={track as unknown as Parameters<typeof VoiceStageVideo>[0]['track']}
      />,
      { container: host },
    )

    const element = popoutDocument.querySelector('video')!

    expect(element.ownerDocument).toBe(popoutDocument)
    expect(element.isConnected).toBe(true)
    expect(track.attach).not.toHaveBeenCalled()
    expect(track.detach).not.toHaveBeenCalled()
  })
})
