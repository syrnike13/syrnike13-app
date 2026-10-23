// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { NativeContextMenuGuard } from '#/components/native-context-menu-guard'

function dispatchContextMenu(target: Element) {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
  return event
}

describe('NativeContextMenuGuard', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('suppresses the native context menu', () => {
    render(<NativeContextMenuGuard />)

    const event = dispatchContextMenu(document.body)

    expect(event.defaultPrevented).toBe(true)
  })

  it('keeps the native context menu for opted-out elements', () => {
    render(<NativeContextMenuGuard />)

    const target = document.createElement('div')
    target.setAttribute('data-native-context-menu', '')
    const child = document.createElement('span')
    target.appendChild(child)
    document.body.appendChild(target)

    const event = dispatchContextMenu(child)

    expect(event.defaultPrevented).toBe(false)
  })

  it('stops suppressing once unmounted', () => {
    const { unmount } = render(<NativeContextMenuGuard />)
    unmount()

    const event = dispatchContextMenu(document.body)

    expect(event.defaultPrevented).toBe(false)
  })
})
