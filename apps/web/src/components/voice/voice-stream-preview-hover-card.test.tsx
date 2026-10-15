// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('#/features/voice/use-watch-participant-screen-share', () => ({
  useWatchParticipantScreenShare: () => vi.fn(),
}))
vi.mock('#/features/diagnostics/diagnostic-reporter', () => ({
  recordDiagnosticEvent: vi.fn(),
}))
import { StreamPreviewCardContent } from './voice-stream-preview-hover-card'

afterEach(cleanup)

describe('stream preview hover card states', () => {
  it('shows loading and unavailable previews with an active watch button', () => {
    const watch = vi.fn()
    const view = render(
      <StreamPreviewCardContent
        imageUrl={null}
        loading
        self={false}
        watching={false}
        onWatch={watch}
      />,
    )
    expect(screen.getByText('Сейчас стримит')).toBeTruthy()
    expect(screen.getByText('Загрузка превью…')).toBeTruthy()
    view.rerender(
      <StreamPreviewCardContent
        imageUrl={null}
        loading={false}
        self={false}
        watching={false}
        onWatch={watch}
      />,
    )
    expect(screen.getByText('Превью пока недоступно')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Смотреть стрим' }))
    expect(watch).toHaveBeenCalledOnce()
  })
  it('disables watch for the local streamer', () => {
    const watch = vi.fn()
    render(
      <StreamPreviewCardContent
        imageUrl={null}
        loading={false}
        self
        watching={false}
        onWatch={watch}
      />,
    )
    const button = screen.getByRole('button', { name: 'Вы стримите!' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(watch).not.toHaveBeenCalled()
  })
  it('disables watch for an already watched stream and displays the preview', () => {
    render(
      <StreamPreviewCardContent
        imageUrl="blob:preview"
        loading={false}
        self={false}
        watching
        onWatch={vi.fn()}
      />,
    )
    expect(
      screen
        .getByRole('button', { name: 'Вы смотрите' })
        .hasAttribute('disabled'),
    ).toBe(true)
    const image = screen.getByAltText('Превью трансляции')
    expect(image.getAttribute('src')).toBe('blob:preview')
    fireEvent.error(image)
    expect(screen.getByText('Превью пока недоступно')).toBeTruthy()
  })
})
