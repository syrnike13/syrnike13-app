// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVoiceStagePresentation } from './use-voice-stage-presentation'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('shared stage presentation lifecycle', () => {
  it('tracks independent mounted views, without removing another view on unmount', () => {
    const { result } = renderHook(() => useVoiceStagePresentation('voice'))
    let first = () => {}
    let second = () => {}
    act(() => {
      first = result.current.registerStageView('voice')
      second = result.current.registerStageView('voice')
    })
    expect(result.current.mountedStageChannelIds).toEqual(['voice', 'voice'])
    act(first)
    expect(result.current.mountedStageChannelIds).toEqual(['voice'])
    act(second)
    expect(result.current.mountedStageChannelIds).toEqual([])
  })
  it('keeps the popout open when the embedded stage unmounts and closes it on channel change', () => {
    // A real jsdom Window supplies the window event lifecycle.
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    vi.spyOn(window, 'open').mockReturnValue(window)
    const { result, rerender } = renderHook(
      ({ channel }) => useVoiceStagePresentation(channel),
      { initialProps: { channel: 'voice' } },
    )
    let detach = () => {}
    act(() => {
      detach = result.current.registerStageView('voice')
      result.current.openStagePopout()
    })
    act(detach)
    expect(result.current.popoutWindow).toBe(window)
    expect(close).not.toHaveBeenCalled()
    rerender({ channel: 'other' })
    expect(close).toHaveBeenCalledOnce()
    expect(result.current.popoutWindow).toBeNull()
  })
  it('clears popout state on native window close', () => {
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    vi.spyOn(window, 'open').mockReturnValue(window)
    const { result } = renderHook(() => useVoiceStagePresentation('voice'))
    act(() => result.current.openStagePopout())
    act(() => window.dispatchEvent(new Event('unload')))
    expect(result.current.popoutWindow).toBeNull()
  })
})
