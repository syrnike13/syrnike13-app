// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useSelfMonitoringCheck } from '#/features/voice/use-self-monitoring-check'

type Props = { requested: boolean; active: boolean }

function setup(initialProps: Props) {
  const setActive = vi.fn()
  const onEnded = vi.fn()
  const hook = renderHook(
    ({ requested, active }: Props) =>
      useSelfMonitoringCheck(requested, active, setActive, onEnded),
    { initialProps },
  )
  return { ...hook, setActive, onEnded }
}

describe('useSelfMonitoringCheck', () => {
  it('does not end a check it did not start', () => {
    const { setActive, unmount } = setup({ requested: false, active: true })
    unmount()
    expect(setActive).not.toHaveBeenCalled()
  })

  it('starts and ends its own check, including when the page goes away', () => {
    const { setActive, rerender } = setup({ requested: false, active: false })
    rerender({ requested: true, active: false })
    expect(setActive).toHaveBeenLastCalledWith(true)

    window.dispatchEvent(new Event('pagehide'))
    expect(setActive).toHaveBeenLastCalledWith(false)

    setActive.mockClear()
    rerender({ requested: false, active: false })
    expect(setActive).toHaveBeenCalledExactlyOnceWith(false)
    window.dispatchEvent(new Event('pagehide'))
    expect(setActive).toHaveBeenCalledOnce()
  })

  it('reports a check the session ended elsewhere', () => {
    const { onEnded, rerender } = setup({ requested: true, active: false })
    rerender({ requested: true, active: true })
    expect(onEnded).not.toHaveBeenCalled()
    rerender({ requested: true, active: false })
    expect(onEnded).toHaveBeenCalledOnce()
  })

  it('ignores the late end of a previous check after a quick restart', () => {
    const { onEnded, rerender } = setup({ requested: true, active: false })
    rerender({ requested: true, active: true })
    // Stop, then Test again before the session reports the stop.
    rerender({ requested: false, active: true })
    rerender({ requested: true, active: true })
    rerender({ requested: true, active: false })
    expect(onEnded).not.toHaveBeenCalled()
    rerender({ requested: true, active: true })
    rerender({ requested: true, active: false })
    expect(onEnded).toHaveBeenCalledOnce()
  })
})
