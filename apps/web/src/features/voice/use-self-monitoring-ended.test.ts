// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useSelfMonitoringEnded } from '#/features/voice/use-self-monitoring-ended'

describe('useSelfMonitoringEnded', () => {
  it('reports only a check that was running and then stopped', () => {
    const onEnded = vi.fn()
    const { rerender } = renderHook(
      ({ active }) => useSelfMonitoringEnded(active, onEnded),
      { initialProps: { active: false } },
    )
    rerender({ active: false })
    expect(onEnded).not.toHaveBeenCalled()

    rerender({ active: true })
    expect(onEnded).not.toHaveBeenCalled()
    rerender({ active: false })
    expect(onEnded).toHaveBeenCalledOnce()
    rerender({ active: false })
    expect(onEnded).toHaveBeenCalledOnce()
  })
})
