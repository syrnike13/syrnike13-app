// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PresetSlider } from '#/components/ui/preset-slider'

const STOPS = [
  { value: 50 },
  { value: 67 },
  { value: 75 },
  { value: 80 },
  { value: 90 },
  { value: 100 },
  { value: 110 },
  { value: 125 },
  { value: 150 },
  { value: 175 },
  { value: 200 },
]

function labels(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-slot="preset-slider-label"]',
    ),
  )
}

function marks(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="slider-mark"]'),
  )
}

function showThumb(container: HTMLElement) {
  container
    .querySelectorAll<HTMLElement>('[data-slot="slider-thumb"]')
    .forEach((thumb) => {
      // jsdom never measures the thumb, so Base UI keeps it hidden until layout.
      thumb.style.visibility = 'visible'
    })
}

function stubRect(element: Element, rect: Partial<DOMRect>) {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 44,
      width: 200,
      height: 44,
      toJSON: () => ({}),
      ...rect,
    }) as DOMRect
}

beforeEach(() => {
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
  Object.defineProperty(Element.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(Element.prototype, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(Element.prototype, 'hasPointerCapture', {
    configurable: true,
    value: vi.fn(() => false),
  })
})

describe('PresetSlider rendering', () => {
  it('renders a label and a tick for every stop', () => {
    const { container } = render(
      <PresetSlider
        stops={STOPS}
        value={100}
        onValueChange={() => {}}
        aria-label="Scale"
      />,
    )

    expect(labels(container)).toHaveLength(STOPS.length)
    expect(marks(container)).toHaveLength(STOPS.length)
    showThumb(container)
    expect(screen.getByRole('slider', { name: 'Scale' })).toBeInTheDocument()
  })

  it('highlights the selected stop', () => {
    const { container } = render(
      <PresetSlider
        stops={STOPS}
        value={125}
        onValueChange={() => {}}
        aria-label="Scale"
      />,
    )

    const selected = labels(container).filter(
      (label) => label.dataset.value === '125',
    )
    expect(selected).toHaveLength(1)
    expect(selected[0]).toHaveAttribute('data-selected')
    expect(selected[0]).toHaveClass('text-success-strong')
    expect(screen.getByRole('slider', { hidden: true })).toHaveAttribute(
      'aria-valuetext',
      '125',
    )
  })

  it('formats visible labels and the accessible value', () => {
    render(
      <PresetSlider
        stops={STOPS}
        value={100}
        onValueChange={() => {}}
        formatValue={(value) => `${value}%`}
        aria-label="Scale"
      />,
    )

    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByRole('slider', { hidden: true })).toHaveAttribute(
      'aria-valuetext',
      '100%',
    )
  })

  it('sorts and deduplicates stops', () => {
    const { container } = render(
      <PresetSlider
        stops={[{ value: 30 }, { value: 10 }, { value: 30 }, { value: 20 }]}
        value={20}
        onValueChange={() => {}}
        aria-label="Order"
      />,
    )

    expect(labels(container).map((label) => label.textContent)).toEqual([
      '10',
      '20',
      '30',
    ])
  })

  it('renders nothing for fewer than two stops', () => {
    const { container } = render(
      <PresetSlider
        stops={[{ value: 10 }]}
        value={10}
        onValueChange={() => {}}
        aria-label="Empty"
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})

describe('PresetSlider layout', () => {
  it('spreads marks evenly in index layout', () => {
    const { container } = render(
      <PresetSlider
        stops={[
          { value: 0 },
          { value: 10 },
          { value: 20 },
          { value: 30 },
          { value: 40 },
        ]}
        value={30}
        layout="index"
        onValueChange={() => {}}
        aria-label="Even"
      />,
    )

    expect(
      marks(container).map((mark) =>
        mark.style.getPropertyValue('--slider-mark-progress'),
      ),
    ).toEqual(['0', '0.25', '0.5', '0.75', '1'])
    expect(screen.getByRole('slider', { hidden: true })).toHaveAttribute('aria-valuetext', '30')
  })

  it('pins edge labels and centres the rest', () => {
    const { container } = render(
      <PresetSlider
        stops={[{ value: 0 }, { value: 50 }, { value: 100 }]}
        value={50}
        onValueChange={() => {}}
        aria-label="Edges"
      />,
    )

    const [first, middle, last] = labels(container)
    expect(first).toHaveClass('left-0')
    expect(middle).toHaveClass('slider-mark-position')
    expect(last).toHaveClass('right-0')
  })

  it('renders a plain slider without labels or ticks', () => {
    const { container } = render(
      <PresetSlider
        stops={[{ value: 0 }, { value: 100 }]}
        value={40}
        mode="continuous"
        step={1}
        showLabels={false}
        showMarks={false}
        onValueChange={() => {}}
        aria-label="Bare"
      />,
    )

    expect(labels(container)).toHaveLength(0)
    expect(marks(container)).toHaveLength(0)
    expect(screen.getByRole('slider', { hidden: true })).toBeInTheDocument()
  })

  it('keeps a tick-only stop hidden until it is selected', () => {
    const stops = [
      { value: 0 },
      { value: 50, label: null },
      { value: 100 },
    ]
    const { container, rerender } = render(
      <PresetSlider
        stops={stops}
        value={0}
        onValueChange={() => {}}
        formatValue={(value) => `${value}%`}
        aria-label="Optional labels"
      />,
    )

    expect(labels(container).map((label) => label.dataset.value)).toEqual([
      '0',
      '100',
    ])
    expect(marks(container)).toHaveLength(3)

    rerender(
      <PresetSlider
        stops={stops}
        value={50}
        onValueChange={() => {}}
        formatValue={(value) => `${value}%`}
        aria-label="Optional labels"
      />,
    )

    const selected = labels(container).find(
      (label) => label.dataset.value === '50',
    )
    expect(selected).toHaveTextContent('50%')
    expect(selected).toHaveAttribute('data-selected')
    expect(screen.getByRole('slider', { hidden: true })).toHaveAttribute(
      'aria-valuetext',
      '50%',
    )
  })

  it('hides secondary labels on narrow containers', () => {
    const { container } = render(
      <PresetSlider
        stops={[
          { value: 0, major: true },
          { value: 50 },
          { value: 75 },
          { value: 100, major: true },
        ]}
        value={75}
        onValueChange={() => {}}
        aria-label="Narrow"
      />,
    )

    const secondary = labels(container).find(
      (label) => label.dataset.value === '50',
    )
    const current = labels(container).find(
      (label) => label.dataset.value === '75',
    )
    const major = labels(container).find(
      (label) => label.dataset.value === '0',
    )

    expect(secondary).toHaveClass('@max-2xl:hidden')
    expect(current).not.toHaveClass('@max-2xl:hidden')
    expect(major).not.toHaveClass('@max-2xl:hidden')
  })
})

describe('PresetSlider keyboard', () => {
  it('moves one stop at a time', () => {
    const onValueChange = vi.fn()
    render(
      <PresetSlider
        stops={STOPS}
        value={100}
        onValueChange={onValueChange}
        aria-label="Scale"
      />,
    )

    const slider = screen.getByRole('slider', { hidden: true })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onValueChange).toHaveBeenCalledWith(110)

    onValueChange.mockClear()
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(onValueChange).toHaveBeenCalledWith(90)
    expect(onValueChange).toHaveBeenCalledTimes(1)
  })

  it('jumps to the edges and by five stops', () => {
    const onValueChange = vi.fn()
    render(
      <PresetSlider
        stops={STOPS}
        value={100}
        onValueChange={onValueChange}
        aria-label="Scale"
      />,
    )

    const slider = screen.getByRole('slider', { hidden: true })
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(onValueChange).toHaveBeenLastCalledWith(50)

    fireEvent.keyDown(slider, { key: 'End' })
    expect(onValueChange).toHaveBeenLastCalledWith(200)

    fireEvent.keyDown(slider, { key: 'PageUp' })
    expect(onValueChange).toHaveBeenLastCalledWith(200)

    fireEvent.keyDown(slider, { key: 'PageDown' })
    expect(onValueChange).toHaveBeenLastCalledWith(50)
  })

  it('skips disabled stops', () => {
    const onValueChange = vi.fn()
    render(
      <PresetSlider
        stops={[
          { value: 50 },
          { value: 100 },
          { value: 125, disabled: true },
          { value: 150 },
        ]}
        value={100}
        onValueChange={onValueChange}
        aria-label="Scale"
      />,
    )

    fireEvent.keyDown(screen.getByRole('slider', { hidden: true }), { key: 'ArrowRight' })
    expect(onValueChange).toHaveBeenCalledWith(150)
  })

  it('steps by value in continuous mode', () => {
    const onValueChange = vi.fn()
    render(
      <PresetSlider
        stops={STOPS}
        value={100}
        mode="continuous"
        step={2}
        onValueChange={onValueChange}
        aria-label="Scale"
      />,
    )

    fireEvent.keyDown(screen.getByRole('slider', { hidden: true }), { key: 'ArrowRight' })
    expect(onValueChange).toHaveBeenCalledWith(102)
  })
})

describe('PresetSlider pointer', () => {
  it('snaps to a stop while dragging', () => {
    const onValueChange = vi.fn()
    const { container } = render(
      <PresetSlider
        stops={STOPS}
        value={100}
        onValueChange={onValueChange}
        aria-label="Scale"
      />,
    )

    const slider = screen.getByRole('slider', { hidden: true }) as HTMLInputElement
    fireEvent.change(slider, { target: { value: '108' } })
    expect(onValueChange).toHaveBeenCalledWith(110)

    expect(container.querySelector('[data-slot="slider"]')).toBeInTheDocument()
  })

  it('snaps to the nearest enabled stop', () => {
    const onValueChange = vi.fn()
    render(
      <PresetSlider
        stops={[
          { value: 50 },
          { value: 100 },
          { value: 125, disabled: true },
          { value: 150 },
        ]}
        value={100}
        onValueChange={onValueChange}
        aria-label="Scale"
      />,
    )

    fireEvent.change(screen.getByRole('slider', { hidden: true }), {
      target: { value: '130' },
    })
    expect(onValueChange).toHaveBeenCalledWith(150)
  })

  it('defers the value until release in release mode', () => {
    const onValueChange = vi.fn()
    const onValueCommitted = vi.fn()
    const { container } = render(
      <PresetSlider
        stops={STOPS}
        value={100}
        drag="release"
        onValueChange={onValueChange}
        onValueCommitted={onValueCommitted}
        aria-label="Scale"
      />,
    )

    const control = container.querySelector<HTMLElement>(
      '[data-base-ui-slider-control]',
    )
    expect(control).not.toBeNull()
    if (!control) return
    const thumb = control.querySelector<HTMLElement>('[data-slot="slider-thumb"]')
    stubRect(control, {})
    if (thumb) stubRect(thumb, { width: 18, height: 18, right: 18, bottom: 18 })

    control.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        clientX: 100,
        clientY: 22,
        buttons: 1,
      }),
    )
    document.dispatchEvent(
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 150,
        clientY: 22,
        buttons: 1,
      }),
    )
    expect(onValueChange).not.toHaveBeenCalled()

    document.dispatchEvent(
      new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 150,
        clientY: 22,
      }),
    )
    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(onValueCommitted).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenCalledWith(onValueCommitted.mock.calls[0][0])
    expect(STOPS.map((stop) => stop.value)).toContain(
      onValueChange.mock.calls[0][0],
    )
  })
})

describe('PresetSlider disabled and labels', () => {
  it('does not select a disabled label', () => {
    const onValueChange = vi.fn()
    const onValueCommitted = vi.fn()
    render(
      <PresetSlider
        stops={[
          { value: 50 },
          { value: 100 },
          { value: 125, disabled: true },
        ]}
        value={100}
        onValueChange={onValueChange}
        onValueCommitted={onValueCommitted}
        aria-label="Scale"
      />,
    )

    fireEvent.click(screen.getByText('125'))
    expect(onValueChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('50'))
    expect(onValueChange).toHaveBeenCalledWith(50)
    expect(onValueCommitted).toHaveBeenCalledWith(50)
  })

  it('selects a stop by clicking its label', () => {
    const onValueChange = vi.fn()
    const onValueCommitted = vi.fn()
    render(
      <PresetSlider
        stops={STOPS}
        value={100}
        onValueChange={onValueChange}
        onValueCommitted={onValueCommitted}
        aria-label="Scale"
      />,
    )

    fireEvent.click(screen.getByText('125'))
    expect(onValueChange).toHaveBeenCalledWith(125)
    expect(onValueCommitted).toHaveBeenCalledWith(125)
  })

  it('does not highlight a label between stops in continuous mode', () => {
    const { container } = render(
      <PresetSlider
        stops={STOPS}
        value={103}
        mode="continuous"
        onValueChange={() => {}}
        aria-label="Scale"
      />,
    )

    expect(
      labels(container).filter((label) => label.hasAttribute('data-selected')),
    ).toHaveLength(0)
  })
})
