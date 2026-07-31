// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { File, User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ImageLightbox } from '#/components/media/image-lightbox'
import { formatMessageTimestamp } from '#/lib/message-time'

vi.mock('#/components/user/user-avatar', () => ({
  UserAvatar: ({ user }: { user?: User | null }) => (
    <div data-testid="user-avatar">{user?.username ?? 'unknown'}</div>
  ),
}))

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

function authorUser(overrides: Partial<User> = {}) {
  return {
    _id: 'user-1',
    username: 'alice',
    display_name: 'Alice',
    ...overrides,
  } as User
}

describe('ImageLightbox', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders a Discord-like fullscreen viewer with original image actions', () => {
    const onOpenChange = vi.fn()

    render(
      <ImageLightbox
        files={[imageFile()]}
        index={0}
        onIndexChange={vi.fn()}
        open
        onOpenChange={onOpenChange}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'poster.png' })
    const image = within(dialog).getByRole('img', { name: 'poster.png' })
    expect(
      image.getAttribute('src')?.endsWith('/attachments/file-1/poster.png'),
    ).toBe(true)
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)')

    fireEvent.click(image)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)')

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

  it('closes when clicking the empty backdrop, but not the image', () => {
    const onOpenChange = vi.fn()

    render(
      <ImageLightbox
        files={[imageFile()]}
        index={0}
        onIndexChange={vi.fn()}
        open
        onOpenChange={onOpenChange}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'poster.png' })
    const image = within(dialog).getByRole('img', { name: 'poster.png' })
    fireEvent.click(image.parentElement!)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('zooms with the mouse wheel and toolbar toggle', () => {
    render(
      <ImageLightbox
        files={[imageFile()]}
        index={0}
        onIndexChange={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'poster.png' })
    const image = within(dialog).getByRole('img', { name: 'poster.png' })
    const stage = image.parentElement!

    fireEvent.wheel(stage, { deltaY: -400 })
    expect(image.style.transform).not.toContain('scale(1)')
    expect(image.style.transform).toMatch(/scale\(([2-9]|1\.\d*[1-9]|[1-9]\d)/)

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Сбросить масштаб' }),
    )
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)')

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Приблизить изображение' }),
    )
    expect(image.style.transform).toBe('translate(0px, 0px) scale(2)')
  })

  it('zooms toward the cursor instead of the image center', () => {
    render(
      <ImageLightbox
        files={[imageFile()]}
        index={0}
        onIndexChange={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'poster.png' })
    const image = within(dialog).getByRole('img', { name: 'poster.png' })
    const stage = image.parentElement!

    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      width: 200,
      height: 200,
      right: 300,
      bottom: 300,
      toJSON: () => ({}),
    })

    // Курсор справа от центра — при зуме offset уйдёт влево, чтобы точка осталась под курсором.
    fireEvent.wheel(stage, { deltaY: -800, clientX: 280, clientY: 200 })

    const match = image.style.transform.match(
      /translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\) scale\((\d+(?:\.\d+)?)\)/,
    )
    expect(match).toBeTruthy()
    const offsetX = Number(match?.[1])
    const scale = Number(match?.[3])
    expect(scale).toBeGreaterThan(1)
    expect(offsetX).toBeLessThan(0)
  })

  it('pans the image by dragging while zoomed', () => {
    const onOpenChange = vi.fn()

    render(
      <ImageLightbox
        files={[imageFile()]}
        index={0}
        onIndexChange={vi.fn()}
        open
        onOpenChange={onOpenChange}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'poster.png' })
    const image = within(dialog).getByRole('img', { name: 'poster.png' })

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Приблизить изображение' }),
    )

    fireEvent.pointerDown(image, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    })
    fireEvent.pointerMove(image, {
      pointerId: 1,
      clientX: 140,
      clientY: 125,
    })
    fireEvent.pointerUp(image, { pointerId: 1 })

    expect(image.style.transform).toBe('translate(40px, 25px) scale(2)')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('shows the message author avatar, role-coloured name, and timestamp', () => {
    const createdAt = new Date('2026-07-31T12:34:00')
    const timestamp = formatMessageTimestamp(createdAt)

    render(
      <ImageLightbox
        files={[imageFile()]}
        index={0}
        onIndexChange={vi.fn()}
        open
        onOpenChange={vi.fn()}
        author={{
          user: authorUser(),
          name: 'Alice',
          nameColor: '#ed4245',
          createdAt,
        }}
      />,
    )

    expect(screen.getByTestId('user-avatar').textContent).toBe('alice')
    const name = screen.getByText('Alice')
    expect(name.getAttribute('style')).toContain('rgb(237, 66, 69)')
    const time = screen.getByText(timestamp)
    expect(time.tagName).toBe('TIME')
    expect(time.getAttribute('dateTime')).toBe(timestamp)
  })

  it('hides gallery controls for a single image', () => {
    render(
      <ImageLightbox
        files={[imageFile()]}
        index={0}
        onIndexChange={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    )

    expect(
      screen.queryByRole('button', { name: 'Предыдущее изображение' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Следующее изображение' }),
    ).toBeNull()
    expect(screen.queryByText('1 / 1')).toBeNull()
    expect(screen.queryByRole('list', { name: 'Миниатюры вложений' })).toBeNull()
  })

  it('pages through a gallery with buttons, arrow keys, and thumbnails', () => {
    const onIndexChange = vi.fn()
    const files = [
      imageFile({ _id: 'file-1', filename: 'one.png' }),
      imageFile({ _id: 'file-2', filename: 'two.png' }),
      imageFile({ _id: 'file-3', filename: 'three.png' }),
    ]

    const { rerender } = render(
      <ImageLightbox
        files={files}
        index={0}
        onIndexChange={onIndexChange}
        open
        onOpenChange={vi.fn()}
      />,
    )

    expect(screen.queryByText('1 / 3')).toBeNull()
    const thumbs = screen.getByRole('list', { name: 'Миниатюры вложений' })
    expect(within(thumbs).getAllByRole('listitem')).toHaveLength(3)

    fireEvent.click(
      screen.getByRole('button', { name: 'Следующее изображение' }),
    )
    expect(onIndexChange).toHaveBeenCalledWith(1)

    fireEvent.click(within(thumbs).getByRole('listitem', { name: 'three.png' }))
    expect(onIndexChange).toHaveBeenCalledWith(2)

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(onIndexChange).toHaveBeenCalledWith(2)

    onIndexChange.mockClear()
    rerender(
      <ImageLightbox
        files={files}
        index={2}
        onIndexChange={onIndexChange}
        open
        onOpenChange={vi.fn()}
      />,
    )

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(onIndexChange).toHaveBeenCalledWith(0)
  })
})
