// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { Slider } from './index'

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 200,
    bottom: 44,
    width: 200,
    height: 44,
    toJSON: () => ({}),
  } as DOMRect)
})

describe('Slider', () => {
  it('renders marks under the track with their progress', () => {
    const { container } = render(
      <Slider
        defaultValue={[40]}
        marks={[{ value: 0 }, { value: 50 }, { value: 100, disabled: true }]}
      />,
    )

    const marks = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="slider-mark"]'),
    )
    expect(marks).toHaveLength(3)
    expect(
      marks.map((mark) =>
        mark.style.getPropertyValue('--slider-mark-progress'),
      ),
    ).toEqual(['0', '0.5', '1'])
    expect(marks[2]).toHaveAttribute('data-disabled')
  })

  it('keeps marks off vertical sliders', () => {
    const { container } = render(
      <Slider
        defaultValue={[40]}
        orientation="vertical"
        marks={[{ value: 0 }, { value: 100 }]}
      />,
    )

    expect(
      container.querySelectorAll('[data-slot="slider-mark"]'),
    ).toHaveLength(0)
  })

  it('names the thumb through aria-labelledby and a custom value text', () => {
    const { container } = render(
      <>
        <span id="slider-label">Volume</span>
        <Slider
          defaultValue={[40]}
          aria-labelledby="slider-label"
          getAriaValueText={() => '40 percent'}
        />
      </>,
    )

    // jsdom never measures the thumb, so Base UI keeps it hidden until layout.
    container
      .querySelectorAll<HTMLElement>('[data-slot="slider-thumb"]')
      .forEach((thumb) => {
        thumb.style.visibility = 'visible'
      })

    const slider = screen.getByRole('slider', { name: 'Volume' })
    expect(slider).toHaveAttribute('aria-valuetext', '40 percent')
  })
})
