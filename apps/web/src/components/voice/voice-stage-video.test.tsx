// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStageVideo } from '#/components/voice/voice-stage-video'
import {
  NativeVideoRegistry,
  NativeVideoTrackAdapter,
} from '#/features/voice/native-video-registry'

function videoTrackStub(trackSid = 'TR_screen') {
  const track = {
    sid: trackSid,
    mediaStreamTrack: {},
    attach: vi.fn((element: HTMLVideoElement) => element),
    detach: vi.fn(),
  }

  return { track }
}

function nativeTrackStub(trackSid = 'local-screen:session') {
  const detach = vi.fn()
  const attachCanvas = vi.fn(
    (
      _trackId: string,
      _canvas: HTMLCanvasElement,
      _onSizeChange?: (size: { width: number; height: number }) => void,
    ) => detach,
  )
  const registry = { attachCanvas } as unknown as NativeVideoRegistry
  return {
    track: new NativeVideoTrackAdapter(trackSid, registry),
    attachCanvas,
    detach,
  }
}

describe('VoiceStageVideo', () => {
  beforeEach(() => {
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

  it('attaches the video element through LiveKit for adaptive stream tracking', () => {
    const { track } = videoTrackStub()

    const first = render(
      <VoiceStageVideo
        mediaId="remote-user:screen"
        track={track as unknown as Parameters<typeof VoiceStageVideo>[0]['track']}
      />,
    )

    const element = document.querySelector('video')!
    expect(track.attach).toHaveBeenCalledWith(element)
    expect(element.isConnected).toBe(true)

    first.unmount()

    expect(track.detach).toHaveBeenCalledWith(element)
    expect(element.srcObject).toBe(null)
  })

  it('creates video elements in the current host document', () => {
    const { track } = videoTrackStub()
    const popoutDocument = document.implementation.createHTMLDocument('popout')
    const host = popoutDocument.createElement('div')
    popoutDocument.body.appendChild(host)

    const view = render(
      <VoiceStageVideo
        mediaId="remote-user:screen"
        track={track as unknown as Parameters<typeof VoiceStageVideo>[0]['track']}
      />,
      { container: host },
    )

    const element = popoutDocument.querySelector('video')!

    expect(element.ownerDocument).toBe(popoutDocument)
    expect(element.isConnected).toBe(true)
    expect(track.attach).toHaveBeenCalledWith(element)

    view.unmount()

    expect(track.detach).toHaveBeenCalledWith(element)
  })

  it('mounts a canvas consumer for a native preview without attaching a video', () => {
    const { track, attachCanvas, detach } = nativeTrackStub()
    const onVideoSizeChange = vi.fn()

    const view = render(
      <VoiceStageVideo
        mediaId="local-user:screen"
        track={track as unknown as Parameters<typeof VoiceStageVideo>[0]['track']}
        onVideoSizeChange={onVideoSizeChange}
      />,
    )

    const canvas = document.querySelector('canvas')!
    expect(document.querySelector('video')).toBeNull()
    expect(attachCanvas).toHaveBeenCalledWith(
      'local-screen:session',
      canvas,
      expect.any(Function),
    )
    const sizeListener = attachCanvas.mock.calls[0][2]
    sizeListener?.({ width: 1920, height: 1080 })
    expect(onVideoSizeChange).toHaveBeenCalledWith({ width: 1920, height: 1080 })

    view.unmount()
    expect(detach).toHaveBeenCalledOnce()
  })

  it('detaches the old native consumer before attaching a replacement track', () => {
    const first = nativeTrackStub('local-screen:first')
    const second = nativeTrackStub('local-screen:second')
    const view = render(
      <VoiceStageVideo
        mediaId="local-user:screen"
        track={first.track as unknown as Parameters<typeof VoiceStageVideo>[0]['track']}
      />,
    )

    view.rerender(
      <VoiceStageVideo
        mediaId="local-user:screen"
        track={second.track as unknown as Parameters<typeof VoiceStageVideo>[0]['track']}
      />,
    )

    expect(first.detach).toHaveBeenCalledOnce()
    expect(second.attachCanvas).toHaveBeenCalledOnce()
    view.unmount()
    expect(second.detach).toHaveBeenCalledOnce()
  })
})
