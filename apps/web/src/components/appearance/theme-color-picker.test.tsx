// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ThemeColorPicker } from './theme-color-picker'

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Picker({ initial = '#5865F2' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return <ThemeColorPicker value={value} onChange={setValue} />
}

it('keeps partial HEX typing, commits shorthand on blur and restores invalid input', () => {
  render(<Picker />)
  const input = screen.getByRole('textbox', { name: 'Цвет HEX' })
  fireEvent.change(input, { target: { value: '#1' } })
  expect(input).toHaveValue('#1')
  fireEvent.change(input, { target: { value: '#abc' } })
  fireEvent.blur(input)
  expect(input).toHaveValue('#AABBCC')
  fireEvent.change(input, { target: { value: 'invalid' } })
  fireEvent.blur(input)
  expect(input).toHaveValue('#AABBCC')
  fireEvent.change(input, { target: { value: '#123456' } })
  expect(screen.getByLabelText('Цвет в системной палитре')).toHaveValue(
    '#123456',
  )
})

it('keeps a hue chosen for black and supports saturation and brightness by keyboard', () => {
  render(<Picker initial="#000000" />)
  const hue = screen.getByRole('group', { name: 'Цветовой тон' })
  for (let step = 0; step < 12; step++)
    fireEvent.keyDown(hue, { key: 'ArrowRight', shiftKey: true })
  const area = screen.getByRole('slider', {
    name: 'Насыщенность и яркость цвета',
  })
  fireEvent.keyDown(area, { key: 'End' })
  fireEvent.keyDown(area, { key: 'ArrowUp', shiftKey: true })
  expect(screen.getByRole('textbox', { name: 'Цвет HEX' })).toHaveValue(
    '#001A00',
  )
  expect(area).toHaveAttribute('aria-valuenow', '100')
  fireEvent.keyDown(area, { key: 'ArrowRight' })
  expect(area).toHaveAttribute('aria-valuenow', '100')
})
