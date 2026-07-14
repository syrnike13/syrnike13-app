// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { CustomThemeEditor } from '#/components/appearance/custom-theme-editor'

const gradient = {
  colors: ['#5865F2', '#F4F4F5'],
  angle: 0,
  saturation: 74,
}

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(cleanup)

describe('CustomThemeEditor', () => {
  it('renders the actual gradient preview', () => {
    render(
      <CustomThemeEditor
        gradient={gradient}
        customized={false}
        onPreview={vi.fn()}
        onChange={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('img', { name: 'Предпросмотр градиента' }).style
        .backgroundImage,
    ).toBe('linear-gradient(0deg, rgb(88, 101, 242), rgb(244, 244, 245))')
  })

  it('adds a stop without inventing an unrelated color', () => {
    const onChange = vi.fn()
    render(
      <CustomThemeEditor
        gradient={gradient}
        customized
        onPreview={vi.fn()}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Добавить цвет' }))
    expect(onChange).toHaveBeenCalledWith({
      ...gradient,
      colors: ['#5865F2', '#F4F4F5', '#F4F4F5'],
    })
  })

  it('commits valid hex input and discards invalid input', () => {
    const onChange = vi.fn()
    render(
      <CustomThemeEditor
        gradient={gradient}
        customized
        onPreview={vi.fn()}
        onChange={onChange}
      />,
    )

    const input = screen.getByRole('textbox', { name: 'HEX цвета 1' })
    fireEvent.change(input, { target: { value: '#112233' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith({
      ...gradient,
      colors: ['#112233', '#F4F4F5'],
    })

    onChange.mockClear()
    fireEvent.change(input, { target: { value: 'invalid' } })
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
  })
})
