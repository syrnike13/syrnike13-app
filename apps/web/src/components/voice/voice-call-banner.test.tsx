// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VoiceCallBanner } from './voice-call-banner'

describe('VoiceCallBanner', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders incoming call controls', () => {
    const onJoin = vi.fn()
    const onDismiss = vi.fn()

    render(
      <VoiceCallBanner
        title="Личный звонок"
        detail="test_isa звонит"
        actionLabel="Присоединиться"
        dismissLabel="Отменить"
        onJoin={onJoin}
        onDismiss={onDismiss}
      />,
    )

    expect(screen.getByText('Личный звонок')).toBeTruthy()
    expect(screen.getByText('test_isa звонит')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Присоединиться' }))
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))

    expect(onJoin).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
