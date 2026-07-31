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

  it('reserves single-image height from metadata aspect ratio before load', () => {
    const { container } = render(
      <MessageAttachments attachments={[imageFile()]} />,
    )

    const box = container.querySelector(
      '[data-attachment-single]',
    ) as HTMLElement | null
    expect(box).toBeTruthy()
    expect(box?.getAttribute('data-aspect-ratio')).toBe(String(640 / 480))
    expect(box?.classList.contains('max-h-96')).toBe(true)
    expect(box?.classList.contains('sm:max-w-[28rem]')).toBe(true)
    expect(box?.classList.contains('bg-border')).toBe(true)
    expect(
      screen
        .getByRole('img', { name: 'poster.png' })
        .getAttribute('src')
        ?.endsWith('/attachments/file-1'),
    ).toBe(true)
  })

  it('reserves a 1:1 box when image metadata has no dimensions', () => {
    const { container } = render(
      <MessageAttachments
        attachments={[
          imageFile({
            metadata: {
              type: 'Image',
              width: 0,
              height: 0,
              animated: false,
            },
          }),
        ]}
      />,
    )

    const box = container.querySelector('[data-attachment-single]')
    expect(box?.getAttribute('data-aspect-ratio')).toBe('1')
    expect(box?.classList.contains('bg-border')).toBe(true)
  })

  it('renders an aspect-aware mosaic for multiple images', () => {
    const { container } = render(
      <MessageAttachments
        attachments={[
          imageFile({
            _id: 'file-1',
            filename: 'one.png',
            metadata: {
              type: 'Image',
              width: 1200,
              height: 600,
              animated: false,
            },
          }),
          imageFile({
            _id: 'file-2',
            filename: 'two.png',
            metadata: {
              type: 'Image',
              width: 400,
              height: 800,
              animated: false,
            },
          }),
          imageFile({
            _id: 'file-3',
            filename: 'three.png',
            metadata: {
              type: 'Image',
              width: 500,
              height: 700,
              animated: false,
            },
          }),
        ]}
      />,
    )

    const mosaic = container.querySelector('[data-attachment-mosaic="3"]')
    expect(mosaic).toBeTruthy()
    const tiles = mosaic?.querySelectorAll(':scope > button')
    expect(tiles?.length).toBe(3)
    expect(tiles?.[0]?.classList.contains('absolute')).toBe(true)
    expect(screen.getByRole('img', { name: 'one.png' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'three.png' })).toBeTruthy()
    expect(screen.queryByText('+1')).toBeNull()
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
    expect(
      within(dialog).getByRole('img', { name: 'two.png' }),
    ).toBeTruthy()
    expect(screen.queryByText('2 / 2')).toBeNull()
  })

  it('shows every image when there are five attachments', () => {
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

    expect(screen.getByRole('img', { name: 'a.png' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'e.png' })).toBeTruthy()
    expect(screen.queryByText('+1')).toBeNull()
  })
})
