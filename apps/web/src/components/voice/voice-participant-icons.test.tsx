// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { VoiceOnAirBadge } from '#/components/voice/voice-participant-icons'

describe('VoiceOnAirBadge', () => {
  it('does not bubble regular clicks when it has a double-click action', () => {
    const onParentClick = vi.fn()
    const onDoubleClick = vi.fn()

    render(
      <div onClick={onParentClick}>
        <VoiceOnAirBadge onDoubleClick={onDoubleClick} />
      </div>,
    )

    const badge = screen.getByLabelText('В эфире')
    fireEvent.click(badge)
    fireEvent.doubleClick(badge)

    expect(onParentClick).not.toHaveBeenCalled()
    expect(onDoubleClick).toHaveBeenCalledOnce()
  })
})
