import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { renderMessageContent } from '#/lib/message-markdown'

const userId = '01KTF53K42MTGBMD6XSHVC55A4'
const roleId = '01KTF53K42MTGBMD6XSHVC55A5'
const channelId = '01KTF53K42MTGBMD6XSHVC55A6'
const emojiId = '01KTF53K42MTGBMD6XSHVC55A7'

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

  it('renders role and channel mentions', () => {
    const html = renderToStaticMarkup(
      <>
        {renderMessageContent(`<%${roleId}> <#${channelId}>`, undefined, undefined, {
          roles: {
            [roleId]: {
              _id: roleId,
              name: 'Модератор',
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

    expect(html).toContain('Модератор')
    expect(html).toContain('general')
    expect(html).not.toContain(roleId)
    expect(html).not.toContain(channelId)
  })

  it('renders custom emoji with an inline wrapper', () => {
    const html = renderToStaticMarkup(
      <>{renderMessageContent(`Привет :${emojiId}:`)}</>,
    )

    expect(html).toMatch(/<p[^>]*>.*<span/)
    expect(html).toContain(`alt="emoji"`)
    expect(html).not.toMatch(/<p[^>]*>.*<div/)
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

  it('keeps an inline mention renderable inside a spoiler', () => {
    const html = renderToStaticMarkup(
      <>
        {renderMessageContent(`||<@${userId}>||`, {
          [userId]: {
            _id: userId,
            username: 'alice',
            display_name: 'Alice',
          } as never,
        })}
      </>,
    )

    expect(html).toContain('@Alice')
    expect(html).not.toContain(userId)
  })
})
