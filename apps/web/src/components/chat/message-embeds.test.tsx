// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { Embed } from '@syrnike13/api-types'
import { afterEach, describe, expect, it } from 'vitest'

import { MessageEmbeds } from '#/components/chat/message-embeds'

afterEach(() => {
  cleanup()
})

function renderEmbeds(embeds: readonly Embed[]) {
  return render(<MessageEmbeds embeds={embeds} />)
}

function embedCard(container: HTMLElement, type: string) {
  return container.querySelector(`[data-embed="${type}"]`) as HTMLElement | null
}

function imageBox(container: HTMLElement) {
  return container.querySelector('[data-embed-image]') as HTMLElement | null
}

describe('MessageEmbeds website previews', () => {
  it('renders title, description, site name and favicon', () => {
    const { container } = renderEmbeds([
      {
        type: 'Website',
        url: 'https://example.com/article',
        title: 'Заголовок статьи',
        description: 'Короткое описание страницы',
        site_name: 'Example',
        icon_url: 'https://example.com/favicon.ico',
        colour: '#5865f2',
      },
    ])

    const card = embedCard(container, 'website')
    expect(card).toBeTruthy()
    expect(card?.style.getPropertyValue('--embed-accent')).toBeTruthy()
    expect(card?.className).toContain('border-l-(--embed-accent)')
    expect(screen.getByText('Example')).toBeTruthy()
    expect(screen.getByText('Короткое описание страницы')).toBeTruthy()

    const link = screen.getByRole('link', { name: 'Заголовок статьи' })
    expect(link.getAttribute('href')).toBe('https://example.com/article')
    expect(link.getAttribute('target')).toBe('_blank')

    const favicon = card?.querySelector('img')?.getAttribute('src') ?? ''
    expect(favicon).toContain('/proxy?url=')
    expect(decodeURIComponent(favicon)).toContain(
      'https://example.com/favicon.ico',
    )
  })

  it('renders a large image with a reserved aspect ratio through the proxy', () => {
    const { container } = renderEmbeds([
      {
        type: 'Website',
        url: 'https://example.com',
        title: 'Пример',
        image: {
          url: 'https://cdn.example.com/cover.png',
          width: 1200,
          height: 630,
          size: 'Large',
        },
      },
    ])

    const box = imageBox(container)
    expect(box).toBeTruthy()
    expect(box?.getAttribute('data-aspect-ratio')).toBe(String(1200 / 630))

    const src =
      screen.getByRole('img', { name: 'Пример' }).getAttribute('src') ?? ''
    expect(src).toContain('/proxy?url=')
    expect(decodeURIComponent(src)).toContain(
      'https://cdn.example.com/cover.png',
    )
  })

  it('keeps a Preview-size image as a thumbnail instead of a hero', () => {
    const { container } = renderEmbeds([
      {
        type: 'Website',
        url: 'https://example.com',
        title: 'Пример',
        image: {
          url: 'https://cdn.example.com/small.png',
          width: 200,
          height: 200,
          size: 'Preview',
        },
      },
    ])

    expect(imageBox(container)).toBeNull()
    expect(screen.getByRole('img', { name: 'Пример' })).toBeTruthy()
  })

  it('renders a video link when the website advertises one', () => {
    const { container } = renderEmbeds([
      {
        type: 'Website',
        url: 'https://example.com',
        title: 'Пример',
        video: {
          url: 'https://cdn.example.com/movie.mp4',
          width: 1280,
          height: 720,
        },
      },
    ])

    const link = container.querySelector(
      '[data-embed-video-link]',
    ) as HTMLAnchorElement | null
    expect(link?.getAttribute('href')).toBe('https://cdn.example.com/movie.mp4')
  })
})

describe('MessageEmbeds standalone media', () => {
  it('renders an image embed as a link with metadata aspect ratio', () => {
    const { container } = renderEmbeds([
      {
        type: 'Image',
        url: 'https://cdn.example.com/photo.jpg',
        width: 800,
        height: 600,
        size: 'Large',
      },
    ])

    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('https://cdn.example.com/photo.jpg')

    const box = imageBox(container)
    expect(box?.getAttribute('data-aspect-ratio')).toBe(String(800 / 600))

    const src =
      screen.getByRole('img', { name: 'Изображение' }).getAttribute('src') ?? ''
    expect(decodeURIComponent(src)).toContain(
      'https://cdn.example.com/photo.jpg',
    )
  })

  it('renders a video embed as an external link', () => {
    const { container } = renderEmbeds([
      {
        type: 'Video',
        url: 'https://www.youtube.com/watch?v=abc',
        width: 1280,
        height: 720,
      },
    ])

    expect(embedCard(container, 'video')).toBeTruthy()

    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe(
      'https://www.youtube.com/watch?v=abc',
    )
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('renders a text embed with an uploaded image and a link', () => {
    const { container } = renderEmbeds([
      {
        type: 'Text',
        title: 'Отчёт',
        description: 'Короткое описание',
        url: 'https://example.com/report',
        media: {
          _id: 'file-1',
          tag: 'attachments',
          filename: 'report.png',
          content_type: 'image/png',
          size: 1024,
          metadata: { type: 'Image', width: 640, height: 480, animated: false },
        },
      },
    ])

    expect(
      screen.getByRole('link', { name: 'Отчёт' }).getAttribute('href'),
    ).toBe('https://example.com/report')
    expect(
      screen.getByRole('img', { name: 'report.png' }).getAttribute('src'),
    ).toContain('/attachments/file-1')
    expect(imageBox(container)?.getAttribute('data-aspect-ratio')).toBe(
      String(640 / 480),
    )
  })

  it('renders a non-image text media as a file link', () => {
    renderEmbeds([
      {
        type: 'Text',
        title: 'Архив',
        media: {
          _id: 'file-2',
          tag: 'attachments',
          filename: 'logs.zip',
          content_type: 'application/zip',
          size: 4096,
          metadata: { type: 'File' },
        },
      },
    ])

    expect(screen.getByText('logs.zip')).toBeTruthy()
  })
})

describe('MessageEmbeds safety and emptiness', () => {
  it('skips None and empty Website embeds', () => {
    const { container } = renderEmbeds([
      { type: 'None' },
      { type: 'Website', title: '   ', description: '' },
    ])

    expect(container.querySelector('[data-message-embeds]')).toBeNull()
    expect(container.querySelector('[data-embed]')).toBeNull()
  })

  it('does not turn a javascript: url into a link', () => {
    renderEmbeds([
      { type: 'Website', url: 'javascript:alert(1)', title: 'Опасно' },
    ])

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Опасно')).toBeTruthy()
  })

  it('ignores an accent colour that is not a plain CSS colour', () => {
    const { container } = renderEmbeds([
      { type: 'Website', title: 'Без акцента', colour: 'red; background: url(x)' },
    ])

    expect(embedCard(container, 'website')?.getAttribute('style')).toBeNull()
  })
})
