import { describe, expect, it } from 'vitest'

import { deserializeMessageContent } from '#/lib/message-format/deserialize'
import { serializeMessageContent } from '#/lib/message-format/serialize'

const userId = '01KTF53K42MTGBMD6XSHVC55A4'
const roleId = '01KTF53K42MTGBMD6XSHVC55A5'
const channelId = '01KTF53K42MTGBMD6XSHVC55A6'
const emojiId = '01KTF53K42MTGBMD6XSHVC55A7'

function roundTrip(input: string) {
  return serializeMessageContent(deserializeMessageContent(input))
}

describe('message-format', () => {
  it('round-trips user mentions', () => {
    const value = `Привет <@${userId}>!`
    expect(roundTrip(value)).toBe(value)
  })

  it('round-trips role and channel mentions', () => {
    const value = `<%${roleId}> <#${channelId}>`
    expect(roundTrip(value)).toBe(value)
  })

  it('round-trips inline formatting', () => {
    const value = '**bold** *italic* ~~strike~~ `code` ||spoiler||'
    expect(roundTrip(value)).toBe(value)
  })

  it('round-trips custom emoji', () => {
    const value = `wave :${emojiId}:`
    expect(roundTrip(value)).toBe(value)
  })

  it('round-trips mass mentions', () => {
    expect(roundTrip('@everyone hi')).toBe('@everyone hi')
    expect(roundTrip('@online hi')).toBe('@online hi')
  })

  it('round-trips multiline paragraphs', () => {
    const value = 'line one\nline two'
    expect(roundTrip(value)).toBe(value)
  })

  it('round-trips paragraph breaks', () => {
    const value = 'first\n\nsecond'
    expect(roundTrip(value)).toBe(value)
  })

  it('round-trips blockquote', () => {
    const value = '> quoted line'
    expect(roundTrip(value)).toBe(value)
  })

  it('round-trips code block', () => {
    const value = '```\nconst x = 1\n```'
    expect(roundTrip(value)).toBe(value)
  })

  it('round-trips bullet list', () => {
    const value = '- one\n- two'
    expect(roundTrip(value)).toBe(value)
  })

  it('merges adjacent bullet lists without blank lines', () => {
    const value = '- one\n\n- two'
    expect(roundTrip(value)).toBe('- one\n- two')
  })

  it('round-trips headings', () => {
    expect(roundTrip('# title')).toBe('# title')
    expect(roundTrip('## subtitle')).toBe('## subtitle')
  })

  it('keeps mention tokens literal inside inline code or after an escape', () => {
    expect(roundTrip(`\`<@${userId}> @everyone\``)).toBe(
      `\`<@${userId}> @everyone\``,
    )
    expect(roundTrip('\\@everyone')).toBe('\\@everyone')
    expect(roundTrip(`\\<@${userId}>`)).toBe(`\\<@${userId}>`)
    expect(roundTrip('\\`@everyone`')).toBe('\\`@everyone`')
  })

  it('round-trips formatting around inline mention atoms', () => {
    expect(roundTrip('**@everyone**')).toBe('**@everyone**')
    expect(roundTrip(`**<@${userId}>**`)).toBe(`**<@${userId}>**`)
  })

  it('does not replace edited link text with its previous URL', () => {
    expect(
      serializeMessageContent({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'понятная ссылка',
                marks: [
                  { type: 'link', attrs: { href: 'https://example.com' } },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe('понятная ссылка')
  })
})
