// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PermissionStateButton } from '#/components/servers/permission-state-button'

describe('PermissionStateButton', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('names each state of the permission for assistive tech', () => {
    const onChange = vi.fn()

    render(
      <PermissionStateButton
        label="Просмотр каналов"
        state="neutral"
        onChange={onChange}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Просмотр каналов: разрешено' }),
    )

    expect(onChange).toHaveBeenCalledWith('allow')
  })

  it('disables states that are not allowed for this permission change', () => {
    render(
      <PermissionStateButton
        label="Просмотр каналов"
        state="neutral"
        allowedStates={['neutral', 'deny']}
        onChange={vi.fn()}
      />,
    )

    expect(
      screen
        .getByRole('button', { name: 'Просмотр каналов: разрешено' })
        .hasAttribute('disabled') ||
        screen
          .getByRole('button', { name: 'Просмотр каналов: разрешено' })
          .getAttribute('aria-disabled') === 'true',
    ).toBe(true)
  })

  it('renders a switch for on/off permissions', () => {
    const onChange = vi.fn()

    render(
      <PermissionStateButton
        label="Просмотр каналов"
        state="neutral"
        mode="switch"
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('switch', { name: 'Просмотр каналов' }))

    expect(onChange).toHaveBeenCalledWith('allow')
  })
})
