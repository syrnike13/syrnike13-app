// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react'
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

function liveKitStageTrack(track: ReturnType<typeof videoTrackStub>['track']) {
  return {
    backend: 'livekit' as const,
    track: track as never,
  }
}

function nativeTrackStub(trackSid = 'local-screen:session') {
  const detach = vi.fn()
  const attachCanvas = vi.fn(
    (
      _trackId: string,
      _canvas: HTMLCanvasElement,
      _onSizeChange?: (size: { width: number; height: number }) => void,
      _options?: { fit?: 'contain' | 'cover'; onFrame?: () => void },
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
        track={liveKitStageTrack(track)}
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
        track={liveKitStageTrack(track)}
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
        track={{ backend: 'native', track }}
        onVideoSizeChange={onVideoSizeChange}
      />,
    )

    const canvas = document.querySelector('canvas')!
    canvas.width = 1920
    canvas.height = 1080
    expect(document.querySelector('video')).toBeNull()
    expect(attachCanvas).toHaveBeenCalledWith(
      'local-screen:session',
      canvas,
      expect.any(Function),
      expect.objectContaining({ fit: 'cover' }),
    )
    const sizeListener = attachCanvas.mock.calls[0][2]
    sizeListener?.({ width: 1920, height: 1080 })
    expect(onVideoSizeChange).toHaveBeenCalledWith({ width: 1920, height: 1080 })

    view.unmount()
    expect(detach).toHaveBeenCalledOnce()
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })

  it('detaches the old native consumer before attaching a replacement track', () => {
    const first = nativeTrackStub('local-screen:first')
    const second = nativeTrackStub('local-screen:second')
    const view = render(
      <VoiceStageVideo
        mediaId="local-user:screen"
        track={{ backend: 'native', track: first.track }}
      />,
    )

    view.rerender(
      <VoiceStageVideo
        mediaId="local-user:screen"
        track={{ backend: 'native', track: second.track }}
      />,
    )

    expect(first.detach).toHaveBeenCalledOnce()
    expect(second.attachCanvas).toHaveBeenCalledOnce()
    view.unmount()
    expect(second.detach).toHaveBeenCalledOnce()
  })

  it('keeps the previous frame on screen until the replacement draws', () => {
    const first = nativeTrackStub('remote-screen:first')
    const second = nativeTrackStub('remote-screen:second')
    const view = render(
      <VoiceStageVideo
        mediaId="remote-user:screen"
        track={{ backend: 'native', track: first.track }}
      />,
    )
    const oldCanvas = document.querySelector('canvas')!
    view.rerender(
      <VoiceStageVideo
        mediaId="remote-user:screen"
        track={{ backend: 'native', track: second.track }}
      />,
    )
    expect(document.querySelectorAll('canvas')).toHaveLength(2)
    expect(oldCanvas.isConnected).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Переключение качества')

    const options = second.attachCanvas.mock.calls[0][3]
    act(() => options?.onFrame?.())
    expect(oldCanvas.isConnected).toBe(false)
    expect(document.querySelectorAll('canvas')).toHaveLength(1)
    expect(screen.queryByRole('status')).toBeNull()
    view.unmount()
  })

  it('shows the loading overlay while the stream is switching quality', () => {
    const { track } = nativeTrackStub('remote-screen:held')
    const view = render(
      <VoiceStageVideo
        mediaId="remote-user:screen"
        track={{ backend: 'native', track, reconnecting: true }}
      />,
    )
    expect(screen.getByRole('status')).toBeTruthy()
    view.rerender(
      <VoiceStageVideo
        mediaId="remote-user:screen"
        track={{ backend: 'native', track }}
      />,
    )
    expect(screen.queryByRole('status')).toBeNull()
    view.unmount()
  })
})
