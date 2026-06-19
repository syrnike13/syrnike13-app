// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { File } from '@syrnike13/api-types'
import { afterEach, describe, expect, it } from 'vitest'

import { MessageAttachments } from '#/components/chat/message-attachments'

function fileAttachment(overrides: Partial<File> = {}) {
  return {
    _id: 'file-1',
    tag: 'attachments',
    filename: 'report.pdf',
    content_type: 'application/pdf',
    size: 1536,
    metadata: {
      type: 'File',
    },
    ...overrides,
  } satisfies File
}

describe('MessageAttachments', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows the size of non-image file attachments', () => {
    render(<MessageAttachments attachments={[fileAttachment()]} />)

    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(screen.getByText('1.5 KB')).toBeTruthy()
  })
})
