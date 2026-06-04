import type { ReactNode } from 'react'
import type { Emoji, User } from '@syrnike13/api-types'

import { CustomEmoji } from '#/components/emoji/custom-emoji'
import { CUSTOM_EMOJI_ID_RE } from '#/lib/emoji'
import { MENTION_RE } from '#/lib/mentions'

function escapeHtml(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const LINK_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]}])/g
const BOLD_RE = /\*\*(.+?)\*\*/g
const ITALIC_RE = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g
const STRIKE_RE = /~~(.+?)~~/g
const CODE_RE = /`([^`]+)`/g
const SPOILER_RE = /\|\|(.+?)\|\|/g
const MASS_MENTION_RE = /(@everyone|@online)/g

type InlineMatch = {
  index: number
  length: number
  type: 'link' | 'bold' | 'italic' | 'strike' | 'code' | 'spoiler' | 'mass'
  full: string
  inner: string
}

function findNextInlineMatch(rest: string): InlineMatch | null {
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
      inner: bold[1],
    })
  }

  const italic = ITALIC_RE.exec(rest)
  if (italic?.index !== undefined) {
    candidates.push({
      index: italic.index,
      length: italic[0].length,
      type: 'italic',
      full: italic[0],
      inner: italic[1],
    })
  }

  const strike = STRIKE_RE.exec(rest)
  if (strike?.index !== undefined) {
    candidates.push({
      index: strike.index,
      length: strike[0].length,
      type: 'strike',
      full: strike[0],
      inner: strike[1],
    })
  }

  const code = CODE_RE.exec(rest)
  if (code?.index !== undefined) {
    candidates.push({
      index: code.index,
      length: code[0].length,
      type: 'code',
      full: code[0],
      inner: code[1],
    })
  }

  const spoiler = SPOILER_RE.exec(rest)
  if (spoiler?.index !== undefined) {
    candidates.push({
      index: spoiler.index,
      length: spoiler[0].length,
      type: 'spoiler',
      full: spoiler[0],
      inner: spoiler[1],
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

  LINK_RE.lastIndex = 0
  BOLD_RE.lastIndex = 0
  ITALIC_RE.lastIndex = 0
  STRIKE_RE.lastIndex = 0
  CODE_RE.lastIndex = 0
  SPOILER_RE.lastIndex = 0
  MASS_MENTION_RE.lastIndex = 0

  if (candidates.length === 0) return null
  return candidates.sort((a, b) => a.index - b.index)[0]!
}

function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let rest = text
  let index = 0

  while (rest.length > 0) {
    const next = findNextInlineMatch(rest)
    if (!next) {
      nodes.push(escapeHtml(rest))
      break
    }

    if (next.index > 0) {
      nodes.push(escapeHtml(rest.slice(0, next.index)))
    }

    const key = `${keyPrefix}-${index}`
    index += 1

    if (next.type === 'link') {
      nodes.push(
        <a
          key={key}
          href={next.full}
          target="_blank"
          rel="noreferrer noopener"
          className="text-primary underline underline-offset-2"
        >
          {next.full}
        </a>,
      )
    } else if (next.type === 'bold') {
      nodes.push(
        <strong key={key} className="font-semibold">
          {escapeHtml(next.inner)}
        </strong>,
      )
    } else if (next.type === 'italic') {
      nodes.push(
        <em key={key} className="italic">
          {escapeHtml(next.inner)}
        </em>,
      )
    } else if (next.type === 'strike') {
      nodes.push(
        <span key={key} className="line-through opacity-80">
          {escapeHtml(next.inner)}
        </span>,
      )
    } else if (next.type === 'spoiler') {
      nodes.push(
        <span
          key={key}
          className="cursor-pointer rounded bg-foreground/10 px-1 text-transparent transition hover:text-inherit"
          title="Спойлер — наведите, чтобы показать"
        >
          {escapeHtml(next.inner)}
        </span>,
      )
    } else if (next.type === 'mass') {
      nodes.push(
        <span
          key={key}
          className="rounded bg-primary/15 px-1 font-medium text-primary"
        >
          {next.inner}
        </span>,
      )
    } else {
      nodes.push(
        <code
          key={key}
          className="rounded bg-background/60 px-1 py-0.5 font-mono text-[0.9em]"
        >
          {escapeHtml(next.inner)}
        </code>,
      )
    }

    rest = rest.slice(next.index + next.length)
  }

  return nodes
}

function parseSegment(
  part: string,
  keyPrefix: string,
  users?: Record<string, User>,
  emojis?: Record<string, Emoji>,
): ReactNode[] {
  const nodes: ReactNode[] = []
  let rest = part
  let segmentIndex = 0

  while (rest.length > 0) {
    CUSTOM_EMOJI_ID_RE.lastIndex = 0
    const emojiMatch = CUSTOM_EMOJI_ID_RE.exec(rest)
    if (!emojiMatch || emojiMatch.index === undefined) {
      nodes.push(...parseInline(rest, keyPrefix))
      break
    }

    const start = emojiMatch.index
    if (start > 0) {
      nodes.push(
        ...parseInline(rest.slice(0, start), `${keyPrefix}-t-${segmentIndex}`),
      )
      segmentIndex += 1
    }

    const emojiId = emojiMatch[1]
    const emoji = emojis?.[emojiId]
    nodes.push(
      <CustomEmoji
        key={`${keyPrefix}-e-${segmentIndex}`}
        emojiId={emojiId}
        name={emoji?.name}
      />,
    )
    segmentIndex += 1
    rest = rest.slice(start + emojiMatch[0].length)
  }

  return nodes
}

function parseLine(
  line: string,
  keyPrefix: string,
  users?: Record<string, User>,
  emojis?: Record<string, Emoji>,
): ReactNode[] {
  const parts = line.split(MENTION_RE)
  const nodes: ReactNode[] = []

  parts.forEach((part, partIndex) => {
    const mentionMatch = part.match(/^<@([0-9ABCDEFGHJKMNPQRSTVWXYZ]{26})>$/)
    if (mentionMatch) {
      const userId = mentionMatch[1]
      const user = users?.[userId]
      nodes.push(
        <span
          key={`${keyPrefix}-m-${partIndex}`}
          className="rounded-sm bg-primary/15 px-0.5 font-medium text-primary hover:bg-primary/25"
        >
          @{user?.display_name ?? user?.username ?? userId}
        </span>,
      )
      return
    }

    if (part) {
      nodes.push(
        ...parseSegment(part, `${keyPrefix}-${partIndex}`, users, emojis),
      )
    }
  })

  return nodes
}

export function renderMessageContent(
  content: string,
  users?: Record<string, User>,
  emojis?: Record<string, Emoji>,
): ReactNode {
  const lines = content.split('\n')
  return lines.map((line, lineIndex) => {
    const quote = line.startsWith('> ')
    const text = quote ? line.slice(2) : line
    const inner = parseLine(text, `line-${lineIndex}`, users, emojis)

    if (quote) {
      return (
        <blockquote
          key={lineIndex}
          className="my-0.5 border-l-2 border-primary/40 pl-2 text-muted-foreground"
        >
          {inner}
        </blockquote>
      )
    }

    return (
      <span key={lineIndex}>
        {lineIndex > 0 ? <br /> : null}
        {inner}
      </span>
    )
  })
}
