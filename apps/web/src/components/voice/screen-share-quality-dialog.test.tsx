// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ScreenShareQualityDialog } from '#/components/voice/screen-share-quality-dialog'

describe('ScreenShareQualityDialog', () => {
  afterEach(() => {
    cleanup()
  })

  it('syncs controls from updated defaults when opened again', () => {
    const props = {
      open: true,
      defaultQuality: 'low' as const,
      defaultAudio: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    }
    const { rerender } = render(<ScreenShareQualityDialog {...props} />)

    expect(screen.getByText('720p, 30 FPS')).toBeTruthy()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)

    rerender(
      <ScreenShareQualityDialog
        {...props}
        defaultQuality="high60"
        defaultAudio={true}
      />,
    )

    expect(screen.getByText('1080p, 60 FPS')).toBeTruthy()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })
})
