// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { File } from '@syrnike13/api-types'
import { afterEach, describe, expect, it } from 'vitest'

import { MessageAttachments } from '#/components/chat/message-attachments'

function imageFile(overrides: Partial<File> = {}) {
  return {
    _id: 'file-1',
    tag: 'attachments',
    filename: 'poster.png',
    content_type: 'image/png',
    size: 2048,
    metadata: {
      type: 'Image',
      width: 640,
      height: 480,
      animated: false,
    },
    ...overrides,
  } satisfies File
}

describe('MessageAttachments', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders a single image with Discord-like preview sizing', () => {
    render(<MessageAttachments attachments={[imageFile()]} />)

    const preview = screen.getByRole('img', { name: 'poster.png' })

    expect(preview.getAttribute('src')?.endsWith('/attachments/file-1')).toBe(
      true,
    )
    expect(preview.parentElement?.classList.contains('max-h-96')).toBe(true)
    expect(preview.parentElement?.classList.contains('sm:max-w-[28rem]')).toBe(
      true,
    )
    expect(preview.parentElement?.classList.contains('cursor-pointer')).toBe(
      true,
    )
  })

  it('lays out multiple images in a mosaic grid', () => {
    const { container } = render(
      <MessageAttachments
        attachments={[
          imageFile({ _id: 'file-1', filename: 'one.png' }),
          imageFile({ _id: 'file-2', filename: 'two.png' }),
          imageFile({ _id: 'file-3', filename: 'three.png' }),
        ]}
      />,
    )

    const mosaic = container.querySelector('[data-attachment-mosaic="3"]')
    expect(mosaic).toBeTruthy()
    expect(mosaic?.classList.contains('grid-cols-2')).toBe(true)
    expect(screen.getByRole('img', { name: 'one.png' }).parentElement?.classList.contains('absolute')).toBe(
      true,
    )
  })

  it('opens the lightbox gallery at the clicked mosaic tile', () => {
    render(
      <MessageAttachments
        attachments={[
          imageFile({ _id: 'file-1', filename: 'one.png' }),
          imageFile({ _id: 'file-2', filename: 'two.png' }),
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('img', { name: 'two.png' }))

    const dialog = screen.getByRole('dialog', { name: 'two.png' })
    expect(within(dialog).getByText('2 / 2')).toBeTruthy()
    expect(
      within(dialog)
        .getByRole('img', { name: 'two.png' })
        .getAttribute('src')
        ?.endsWith('/attachments/file-2/two.png'),
    ).toBe(true)
  })

  it('shows an overflow badge when there are more than four images', () => {
    render(
      <MessageAttachments
        attachments={[
          imageFile({ _id: 'a', filename: 'a.png' }),
          imageFile({ _id: 'b', filename: 'b.png' }),
          imageFile({ _id: 'c', filename: 'c.png' }),
          imageFile({ _id: 'd', filename: 'd.png' }),
          imageFile({ _id: 'e', filename: 'e.png' }),
        ]}
      />,
    )

    expect(screen.getByText('+1')).toBeTruthy()
  })
})
