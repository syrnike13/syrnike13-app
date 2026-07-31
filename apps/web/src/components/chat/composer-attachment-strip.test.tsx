// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ComposerAttachmentStrip } from '#/components/chat/composer-attachment-strip'
import type { PendingComposerFile } from '#/lib/composer-files'

function pendingFile(
  overrides: Partial<PendingComposerFile> & Pick<PendingComposerFile, 'id'>,
): PendingComposerFile {
  return {
    file: new File(['hello'], overrides.file?.name ?? 'notes.txt', {
      type: overrides.file?.type ?? 'text/plain',
    }),
    status: 'pending',
    ...overrides,
  }
}

describe('ComposerAttachmentStrip', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders nothing without files', () => {
    const { container } = render(
      <ComposerAttachmentStrip
        files={[]}
        sending={false}
        onRemove={vi.fn()}
        onToggleSpoiler={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows preview, filename, progress, error, spoiler and remove actions', () => {
    const onRemove = vi.fn()
    const onToggleSpoiler = vi.fn()

    render(
      <ComposerAttachmentStrip
        sending={false}
        onRemove={onRemove}
        onToggleSpoiler={onToggleSpoiler}
        files={[
          pendingFile({
            id: 'img-1',
            previewUrl: 'blob:preview',
            file: new File(['x'], 'photo.png', { type: 'image/png' }),
          }),
          pendingFile({
            id: 'doc-1',
            file: new File(['y'], 'report.pdf', { type: 'application/pdf' }),
          }),
          pendingFile({
            id: 'up-1',
            status: 'uploading',
            progress: 0.4,
            file: new File(['z'], 'upload.bin', {
              type: 'application/octet-stream',
            }),
          }),
          pendingFile({
            id: 'err-1',
            status: 'error',
            error: 'Слишком большой файл',
            file: new File(['w'], 'big.zip', { type: 'application/zip' }),
          }),
        ]}
      />,
    )

    expect(screen.getByLabelText('Вложения')).toBeTruthy()
    expect(screen.getByAltText('photo.png')).toBeTruthy()
    expect(screen.getByText('photo.png')).toBeTruthy()
    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(screen.getByLabelText('Загружено 40%')).toBeTruthy()
    expect(screen.getByText('Слишком большой файл')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Пометить photo.png как спойлер'))
    expect(onToggleSpoiler).toHaveBeenCalledWith('img-1')

    fireEvent.click(screen.getByLabelText('Удалить вложение photo.png'))
    expect(onRemove).toHaveBeenCalledWith('img-1')
  })
})
