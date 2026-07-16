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

  it('skips states that are not allowed for this permission change', () => {
    const onChange = vi.fn()

    render(
      <PermissionStateButton
        label="РџСЂРѕСЃРјРѕС‚СЂ РєР°РЅР°Р»РѕРІ"
        state="neutral"
        allowedStates={['neutral', 'deny']}
        onChange={onChange}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: /наследуется/i,
      }),
    )

    expect(onChange).toHaveBeenCalledWith('deny')
  })
})
