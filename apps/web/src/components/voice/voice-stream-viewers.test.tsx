// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@syrnike13/ui/i18n'

import ru from '#/messages/ru.json'
import {
  VoiceStreamViewers,
  streamViewerCountLabel,
  streamViewersSummary,
  type StreamViewer,
} from '#/components/voice/voice-stream-viewers'

const t = createTranslator(ru, 'ru', 'voice')

function viewers(count: number): StreamViewer[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `viewer-${index}`,
    displayName: `Зритель ${index}`,
  }))
}

describe('VoiceStreamViewers', () => {
  afterEach(() => {
    cleanup()
  })

  it('declines the viewer count in Russian', () => {
    expect(streamViewerCountLabel(1, t)).toBe('1 зритель')
    expect(streamViewerCountLabel(3, t)).toBe('3 зрителя')
    expect(streamViewerCountLabel(5, t)).toBe('5 зрителей')
    expect(streamViewerCountLabel(11, t)).toBe('11 зрителей')
    expect(streamViewerCountLabel(22, t)).toBe('22 зрителя')
  })

  it('names one or two viewers and counts larger audiences', () => {
    expect(streamViewersSummary(viewers(1), t)).toBe('Смотрит Зритель 0')
    expect(streamViewersSummary(viewers(2), t)).toBe(
      'Смотрят Зритель 0 и Зритель 1',
    )
    expect(streamViewersSummary(viewers(4), t)).toBe('Смотрят 4 зрителя')
  })

  it('renders nothing without viewers', () => {
    const { container } = render(
      <VoiceStreamViewers viewers={[]} variant="avatars" />,
    )

    expect(container.childElementCount).toBe(0)
  })

  it('replaces the last avatar slot with the overflow count', () => {
    render(<VoiceStreamViewers viewers={viewers(5)} variant="avatars" />)

    expect(screen.getByText('+3')).toBeTruthy()
    expect(screen.getByLabelText('Смотрят 5 зрителей')).toBeTruthy()
  })

  it('lists every viewer on click without focusing the tile', () => {
    const onTileClick = vi.fn()
    render(
      <div onClick={onTileClick}>
        <VoiceStreamViewers viewers={viewers(2)} variant="avatars" />
      </div>,
    )

    fireEvent.click(screen.getByLabelText('Смотрят Зритель 0 и Зритель 1'))

    expect(screen.getByText('2 зрителя')).toBeTruthy()
    expect(screen.getByText('Зритель 1')).toBeTruthy()
    expect(onTileClick).not.toHaveBeenCalled()
  })

  it('shows an eye with the count in the compact variant', () => {
    render(<VoiceStreamViewers viewers={viewers(3)} variant="count" />)

    expect(screen.getByLabelText('Смотрят 3 зрителя').textContent).toBe('3')
  })
})
