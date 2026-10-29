// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ThemeEditorDialog } from './theme-editor-dialog'
import {
  anchorsForNewTheme,
  deriveSurfaceAnchors,
} from '#/features/appearance/appearance-themes'

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('resets a gradient draft and saves independent light/dark gradients through the shared save bar', async () => {
  const onSubmit = vi.fn()
  render(
    <ThemeEditorDialog
      open
      initial={{
        id: 'custom-gradient',
        name: 'Prism',
        anchors: anchorsForNewTheme(),
      }}
      initialAnchors={null}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />,
  )
  const add = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Добавить цвет' }))
  add()
  expect(
    screen.getByRole('button', { name: 'Цвет градиента 2' }),
  ).toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: 'Сбросить' }))
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Цвет градиента 1' }),
    ).not.toBeInTheDocument(),
  )
  fireEvent.click(screen.getByRole('tab', { name: 'Тёмная' }))
  add()
  fireEvent.click(screen.getByRole('button', { name: 'Цвет градиента 1' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Цвет HEX' }), {
    target: { value: '#4c1d95' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Цвет градиента 2' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Цвет HEX' }), {
    target: { value: '#be185d' },
  })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled(),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      anchors: {
        light: expect.not.objectContaining({ gradient: expect.anything() }),
        dark: expect.objectContaining({
          gradient: { colors: ['#4C1D95', '#BE185D'], angle: 135, mix: 60 },
        }),
      },
    }),
  )
})

it('limits gradient colors to 2–5 and returns to an anchor when switching to a solid variant', () => {
  render(
    <ThemeEditorDialog
      open
      initial={null}
      initialAnchors={null}
      onOpenChange={() => {}}
      onSubmit={() => {}}
    />,
  )
  const add = screen.getByRole('button', { name: 'Добавить цвет' })
  for (let index = 0; index < 4; index++) fireEvent.click(add)
  expect(add).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'Цвет градиента 5' }),
  ).toHaveAttribute('aria-pressed', 'true')
  for (let index = 0; index < 3; index++)
    fireEvent.click(screen.getByRole('button', { name: 'Удалить цвет' }))
  // Removing a stop at the minimum turns the gradient off.
  fireEvent.click(screen.getByRole('button', { name: 'Удалить цвет' }))
  expect(
    screen.queryByRole('button', { name: 'Цвет градиента 1' }),
  ).not.toBeInTheDocument()
  // The first «Акцент» is the strip marker, which is selected again.
  expect(screen.getAllByRole('button', { name: 'Акцент' })[0]).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  fireEvent.click(screen.getByRole('tab', { name: 'Тёмная' }))
  expect(screen.getAllByRole('button', { name: 'Акцент' })[0]).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(screen.getByRole('textbox', { name: 'Цвет HEX' })).toHaveValue(
    anchorsForNewTheme().dark.accent.toUpperCase(),
  )
})

it('randomizes colors without losing the name or enabled gradient variants', async () => {
  const onSubmit = vi.fn()
  const anchors = anchorsForNewTheme()
  anchors.dark.gradient = {
    colors: ['#112233', '#445566'],
    angle: 135,
    mix: 60,
  }
  render(
    <ThemeEditorDialog
      open
      initial={{ id: 'custom-random', name: 'My palette', anchors }}
      initialAnchors={null}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Удивите меня!' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'My palette',
      anchors: {
        light: expect.not.objectContaining({ gradient: expect.anything() }),
        dark: expect.objectContaining({
          gradient: expect.objectContaining({ colors: expect.any(Array) }),
        }),
      },
    }),
  )
})

it('derives background and text from one accent until the extra colors are opened', async () => {
  const onSubmit = vi.fn()
  const anchors = anchorsForNewTheme()
  for (const variant of ['light', 'dark'] as const)
    Object.assign(
      anchors[variant],
      deriveSurfaceAnchors(variant, anchors[variant].accent),
    )
  render(
    <ThemeEditorDialog
      open
      initial={{ id: 'custom-simple', name: 'Simple', anchors }}
      initialAnchors={null}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />,
  )
  expect(
    screen.queryByRole('button', { name: 'Фон' }),
  ).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'Цвет HEX' }), {
    target: { value: '#d9381e' },
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))
  const saved = onSubmit.mock.calls[0]![0].anchors.light
  expect(saved.accent).toBe('#D9381E')
  expect(saved).toMatchObject(deriveSurfaceAnchors('light', '#D9381E'))
})
