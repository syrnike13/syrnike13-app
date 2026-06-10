import type { JSONContent } from '@tiptap/core'

import { CUSTOM_EMOJI_ID_RE } from '#/lib/emoji'
import { MESSAGE_ENTITY_RE } from '#/lib/mentions'

import type { InlineMatch } from '#/lib/message-format/types'

const LINK_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]}])/g
const BOLD_RE = /\*\*(.+?)\*\*/g
const ITALIC_RE = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g
const STRIKE_RE = /~~(.+?)~~/g
const CODE_RE = /`([^`]+)`/g
const SPOILER_RE = /\|\|(.+?)\|\|/g
const MASS_MENTION_RE = /(@everyone|@online)/g

function resetInlineRegexes() {
  LINK_RE.lastIndex = 0
  BOLD_RE.lastIndex = 0
  ITALIC_RE.lastIndex = 0
  STRIKE_RE.lastIndex = 0
  CODE_RE.lastIndex = 0
  SPOILER_RE.lastIndex = 0
  MASS_MENTION_RE.lastIndex = 0
  MESSAGE_ENTITY_RE.lastIndex = 0
  CUSTOM_EMOJI_ID_RE.lastIndex = 0
}

function findNextFormattingMatch(rest: string): InlineMatch | null {
  const candidates: InlineMatch[] = []

  const link = LINK_RE.exec(rest)
  if (link?.index !== undefined) {
    candidates.push({
      index: link.index,
      length: link[0].length,
      type: 'link',
      full: link[0],
      inner: link[0],
    })
  }

  const bold = BOLD_RE.exec(rest)
  if (bold?.index !== undefined) {
    candidates.push({
      index: bold.index,
      length: bold[0].length,
      type: 'bold',
      full: bold[0],
      inner: bold[1]!,
    })
  }

  const italic = ITALIC_RE.exec(rest)
  if (italic?.index !== undefined) {
    candidates.push({
      index: italic.index,
      length: italic[0].length,
      type: 'italic',
      full: italic[0],
      inner: italic[1]!,
    })
  }

  const strike = STRIKE_RE.exec(rest)
  if (strike?.index !== undefined) {
    candidates.push({
      index: strike.index,
      length: strike[0].length,
      type: 'strike',
      full: strike[0],
      inner: strike[1]!,
    })
  }

  const code = CODE_RE.exec(rest)
  if (code?.index !== undefined) {
    candidates.push({
      index: code.index,
      length: code[0].length,
      type: 'code',
      full: code[0],
      inner: code[1]!,
    })
  }

  const spoiler = SPOILER_RE.exec(rest)
  if (spoiler?.index !== undefined) {
    candidates.push({
      index: spoiler.index,
      length: spoiler[0].length,
      type: 'spoiler',
      full: spoiler[0],
      inner: spoiler[1]!,
    })
  }

  const mass = MASS_MENTION_RE.exec(rest)
  if (mass?.index !== undefined) {
    candidates.push({
      index: mass.index,
      length: mass[0].length,
      type: 'mass',
      full: mass[0],
      inner: mass[0],
    })
  }

  resetInlineRegexes()

  if (candidates.length === 0) return null
  return candidates.sort((a, b) => a.index - b.index)[0]!
}

function findNextEntityOrEmojiMatch(rest: string): InlineMatch | null {
  MESSAGE_ENTITY_RE.lastIndex = 0
  CUSTOM_EMOJI_ID_RE.lastIndex = 0

  const entity = MESSAGE_ENTITY_RE.exec(rest)
  const emoji = CUSTOM_EMOJI_ID_RE.exec(rest)

  const candidates: InlineMatch[] = []

  if (entity?.index !== undefined) {
    const marker = entity[1]!
    const id = entity[2]!
    candidates.push({
      index: entity.index,
      length: entity[0].length,
      type:
        marker === '@'
          ? 'userMention'
          : marker === '%'
            ? 'roleMention'
            : 'channelMention',
      full: entity[0],
      inner: id,
      id,
    })
  }

  if (emoji?.index !== undefined) {
    candidates.push({
      index: emoji.index,
      length: emoji[0].length,
      type: 'customEmoji',
      full: emoji[0],
      inner: emoji[1]!,
      id: emoji[1]!,
    })
  }

  if (candidates.length === 0) return null
  return candidates.sort((a, b) => a.index - b.index)[0]!
}

function textNode(text: string, marks?: JSONContent['marks']): JSONContent {
  const node: JSONContent = { type: 'text', text }
  if (marks?.length) node.marks = marks
  return node
}

function parseFormattedText(text: string): JSONContent[] {
  const nodes: JSONContent[] = []
  let rest = text

  while (rest.length > 0) {
    const next = findNextFormattingMatch(rest)
    if (!next) {
      if (rest) nodes.push(textNode(rest))
      break
    }

    if (next.index > 0) {
      nodes.push(textNode(rest.slice(0, next.index)))
    }

    if (next.type === 'link') {
      nodes.push(
        textNode(next.inner, [{ type: 'link', attrs: { href: next.inner } }]),
      )
    } else if (next.type === 'bold') {
      nodes.push(...parseFormattedText(next.inner).map(wrapBold))
    } else if (next.type === 'italic') {
      nodes.push(...parseFormattedText(next.inner).map(wrapItalic))
    } else if (next.type === 'strike') {
      nodes.push(...parseFormattedText(next.inner).map(wrapStrike))
    } else if (next.type === 'spoiler') {
      nodes.push(...parseFormattedText(next.inner).map(wrapSpoiler))
    } else if (next.type === 'code') {
      nodes.push(textNode(next.inner, [{ type: 'code' }]))
    } else if (next.type === 'mass') {
      nodes.push({
        type: 'massMention',
        attrs: { kind: next.inner === '@online' ? 'online' : 'everyone' },
      })
    }

    rest = rest.slice(next.index + next.length)
  }

  return nodes
}

function wrapBold(node: JSONContent): JSONContent {
  if (node.type !== 'text') return node
  return {
    ...node,
    marks: [...(node.marks ?? []), { type: 'bold' }],
  }
}

function wrapItalic(node: JSONContent): JSONContent {
  if (node.type !== 'text') return node
  return {
    ...node,
    marks: [...(node.marks ?? []), { type: 'italic' }],
  }
}

function wrapStrike(node: JSONContent): JSONContent {
  if (node.type !== 'text') return node
  return {
    ...node,
    marks: [...(node.marks ?? []), { type: 'strike' }],
  }
}

function wrapSpoiler(node: JSONContent): JSONContent {
  if (node.type !== 'text') return node
  return {
    ...node,
    marks: [...(node.marks ?? []), { type: 'spoiler' }],
  }
}

export function parseInlineLine(line: string): JSONContent[] {
  const nodes: JSONContent[] = []
  let rest = line

  while (rest.length > 0) {
    const next = findNextEntityOrEmojiMatch(rest)
    if (!next) {
      nodes.push(...parseFormattedText(rest))
      break
    }

    if (next.index > 0) {
      nodes.push(...parseFormattedText(rest.slice(0, next.index)))
    }

    if (next.type === 'userMention') {
      nodes.push({ type: 'userMention', attrs: { id: next.id } })
    } else if (next.type === 'roleMention') {
      nodes.push({ type: 'roleMention', attrs: { id: next.id } })
    } else if (next.type === 'channelMention') {
      nodes.push({ type: 'channelMention', attrs: { id: next.id } })
    } else if (next.type === 'customEmoji') {
      nodes.push({ type: 'customEmoji', attrs: { id: next.id } })
    }

    rest = rest.slice(next.index + next.length)
  }

  if (nodes.length === 0) {
    return [{ type: 'text', text: '' }]
  }

  return nodes
}
