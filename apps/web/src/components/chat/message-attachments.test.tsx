// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
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

  it('renders image thumbnails a little larger for Discord-like previews', () => {
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
    expect(preview.parentElement?.classList.contains('cursor-zoom-in')).toBe(
      false,
    )
  })
})
