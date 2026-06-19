// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'

import { renderMessageContent } from '#/lib/message-markdown'

const userId = '01KTF53K42MTGBMD6XSHVC55A4'
const roleId = '01KTF53K42MTGBMD6XSHVC55A5'
const channelId = '01KTF53K42MTGBMD6XSHVC55A6'

afterEach(() => {
  cleanup()
})

describe('renderMessageContent', () => {
  it('renders user mentions instead of raw ids', () => {
    const html = renderToStaticMarkup(
      <>
        {renderMessageContent(`Привет <@${userId}>`, {
          [userId]: {
            _id: userId,
            username: 'waflya',
            discriminator: '0001',
            display_name: 'waflyaZOVMAX',
            relationship: 'None',
            online: true,
          },
        })}
      </>,
    )

    expect(html).toContain('waflyaZOVMAX')
    expect(html).not.toContain(userId)
  })

  it('renders role, channel, and mass mentions with Discord-like prefixes', () => {
    const html = renderToStaticMarkup(
      <>
        {renderMessageContent(`<%${roleId}> <#${channelId}> @everyone`, undefined, undefined, {
          roles: {
            [roleId]: {
              _id: roleId,
              name: 'Moderator',
              colour: '#ff5500',
              permissions: { a: 0, d: 0 },
              mentionable: false,
              rank: 0,
            },
          },
          channels: {
            [channelId]: {
              _id: channelId,
              channel_type: 'TextChannel',
              name: 'general',
              server: 'server-1',
            },
          },
        })}
      </>,
    )

    expect(html).toContain('>@Moderator</span>')
    expect(html).toContain('color:#ff5500')
    expect(html).toContain('>#general</span>')
    expect(html).toContain('>@everyone</span>')
    expect(html).not.toContain('@@Moderator')
    expect(html).not.toContain('@#general')
    expect(html).not.toContain('@@everyone')
    expect(html).not.toContain(roleId)
    expect(html).not.toContain(channelId)
  })

  it('does not render mass mentions inside words or email addresses', () => {
    const html = renderToStaticMarkup(
      <>
        {renderMessageContent(
          'foo@everyone.com abc@online @everyone @online',
        )}
      </>,
    )

    expect(html).toContain('foo@everyone.com')
    expect(html).toContain('abc@online')
    expect(html.match(/>@everyone<\/span>/g)).toHaveLength(1)
    expect(html.match(/>@online<\/span>/g)).toHaveLength(1)
  })

  it('renders markdown headings', () => {
    const html = renderToStaticMarkup(
      <>{renderMessageContent('# 123\n## 456')}</>,
    )

    expect(html).toContain('<h1')
    expect(html).toContain('123')
    expect(html).toContain('<h2')
    expect(html).toContain('456')
    expect(html).not.toContain('##')
  })

  it('keeps loose list items on the same line as their bullet', () => {
    const html = renderToStaticMarkup(
      <>
        {renderMessageContent(`**Чат**

- Первый пункт

- Второй пункт`)}
      </>,
    )

    expect(html).toContain('p:only-child]:inline')
    expect(html).toContain('Первый пункт')
    expect(html).toContain('Второй пункт')
  })

  it('reveals spoilers by click and keyboard activation', () => {
    render(<>{renderMessageContent('||click secret|| ||keyboard secret||')}</>)

    const [clickSpoiler, keyboardSpoiler] = screen.getAllByRole('button', {
      name: 'Показать спойлер',
    })

    expect(clickSpoiler?.getAttribute('aria-pressed')).toBe('false')
    expect(clickSpoiler?.className).toContain('text-transparent')
    expect(clickSpoiler?.className).not.toContain('hover:text-inherit')

    fireEvent.click(clickSpoiler!)

    expect(clickSpoiler?.getAttribute('aria-pressed')).toBe('true')
    expect(clickSpoiler?.getAttribute('aria-label')).toBe('Спойлер раскрыт')
    expect(clickSpoiler?.className).not.toContain('text-transparent')

    fireEvent.keyDown(keyboardSpoiler!, { key: 'Enter' })

    expect(keyboardSpoiler?.getAttribute('aria-pressed')).toBe('true')
    expect(keyboardSpoiler?.className).not.toContain('text-transparent')
  })
})
