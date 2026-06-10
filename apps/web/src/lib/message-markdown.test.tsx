import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { renderMessageContent } from '#/lib/message-markdown'

const userId = '01KTF53K42MTGBMD6XSHVC55A4'
const roleId = '01KTF53K42MTGBMD6XSHVC55A5'
const channelId = '01KTF53K42MTGBMD6XSHVC55A6'

describe('renderMessageContent', () => {
  it('renders user mentions instead of raw ids', () => {
    const html = renderToStaticMarkup(
      <>
        {renderMessageContent(`Привет <@${userId}>`, {
          [userId]: {
            _id: userId,
            username: 'waflya',
            display_name: 'waflyaZOVMAX',
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
              name: 'Модератор',
              permissions: 0,
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
})
