// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PermissionStateButton } from '#/components/servers/permission-state-button'

describe('PermissionStateButton', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('names the permission and current state for assistive tech', () => {
    const onChange = vi.fn()

    render(
      <PermissionStateButton
        label="Просмотр каналов"
        state="neutral"
        onChange={onChange}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Просмотр каналов: наследуется',
      }),
    )

    expect(onChange).toHaveBeenCalledWith('allow')
  })
})
