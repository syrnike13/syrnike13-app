import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'

import { deserializeMessageContent } from '#/lib/message-format/deserialize'
import { serializeMessageContent } from '#/lib/message-format/serialize'

const userId = '01KTF53K42MTGBMD6XSHVC55A4'
const roleId = '01KTF53K42MTGBMD6XSHVC55A5'
const channelId = '01KTF53K42MTGBMD6XSHVC55A6'
const emojiId = '01KTF53K42MTGBMD6XSHVC55A7'

function roundTrip(input: string) {
  return serializeMessageContent(deserializeMessageContent(input))
}

function countNodesByType(node: JSONContent, type: string): number {
  return (
    (node.type === type ? 1 : 0) +
    (node.content ?? []).reduce(
      (total, child) => total + countNodesByType(child, type),
      0,
    )
  )
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

  it('parses mass mentions only as standalone tokens', () => {
    const value = 'foo@everyone.com abc@online @everyone @online'
    const document = deserializeMessageContent(value)

    expect(countNodesByType(document, 'massMention')).toBe(2)
    expect(serializeMessageContent(document)).toBe(value)
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
})
