// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { File } from '@syrnike13/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ImageLightbox } from '#/components/media/image-lightbox'

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

describe('ImageLightbox', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders a Discord-like fullscreen viewer with original image actions', () => {
    const onOpenChange = vi.fn()

    render(
      <ImageLightbox
        file={imageFile()}
        open
        onOpenChange={onOpenChange}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'poster.png' })
    const image = within(dialog).getByRole('img', { name: 'poster.png' })
    expect(
      image.getAttribute('src')?.endsWith('/attachments/file-1/poster.png'),
    ).toBe(true)
    expect(image.classList.contains('cursor-pointer')).toBe(true)
    expect(image.classList.contains('cursor-zoom-in')).toBe(false)
    expect(image.classList.contains('cursor-zoom-out')).toBe(false)

    fireEvent.click(image)
    expect(image.classList.contains('scale-110')).toBe(true)
    expect(image.classList.contains('cursor-pointer')).toBe(true)

    const openOriginal = within(dialog).getByRole('link', {
      name: 'Открыть оригинал',
    })
    expect(
      openOriginal
        .getAttribute('href')
        ?.endsWith('/attachments/file-1/poster.png'),
    ).toBe(true)
    expect(openOriginal.getAttribute('target')).toBe('_blank')

    const download = within(dialog).getByRole('link', {
      name: 'Скачать изображение',
    })
    expect(download.getAttribute('download')).toBe('poster.png')

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Закрыть просмотр изображения',
      }),
    )

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
