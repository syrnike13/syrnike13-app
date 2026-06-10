import type { JSONContent } from '@tiptap/core'

import { parseInlineLine } from '#/lib/message-format/inline-parse'
import type { MessageDocument } from '#/lib/message-format/types'

function paragraphFromLines(lines: string[]): JSONContent {
  const content: JSONContent[] = []

  lines.forEach((line, index) => {
    if (index > 0) {
      content.push({ type: 'hardBreak' })
    }
    content.push(...parseInlineLine(line))
  })

  return { type: 'paragraph', content }
}

function parseCodeBlock(
  lines: string[],
  startIndex: number,
): { node: JSONContent; nextIndex: number } {
  const fence = lines[startIndex]!
  const language = fence.slice(3).trim() || null
  const codeLines: string[] = []
  let index = startIndex + 1

  while (index < lines.length && !lines[index]!.startsWith('```')) {
    codeLines.push(lines[index]!)
    index += 1
  }

  return {
    node: {
      type: 'codeBlock',
      attrs: language ? { language } : {},
      content: [{ type: 'text', text: codeLines.join('\n') }],
    },
    nextIndex: index < lines.length ? index + 1 : index,
  }
}

function parseBlockquote(
  lines: string[],
  startIndex: number,
): { node: JSONContent; nextIndex: number } {
  const quoteLines: string[] = []
  let index = startIndex

  while (index < lines.length && lines[index]!.startsWith('> ')) {
    quoteLines.push(lines[index]!.slice(2))
    index += 1
  }

  return {
    node: {
      type: 'blockquote',
      content: [paragraphFromLines(quoteLines)],
    },
    nextIndex: index,
  }
}

function parseBulletList(
  lines: string[],
  startIndex: number,
): { node: JSONContent; nextIndex: number } {
  const items: JSONContent[] = []
  let index = startIndex

  while (index < lines.length && /^[-*] /.test(lines[index]!)) {
    const text = lines[index]!.replace(/^[-*] /, '')
    items.push({
      type: 'listItem',
      content: [{ type: 'paragraph', content: parseInlineLine(text) }],
    })
    index += 1
  }

  return {
    node: { type: 'bulletList', content: items },
    nextIndex: index,
  }
}

function parseOrderedList(
  lines: string[],
  startIndex: number,
): { node: JSONContent; nextIndex: number } {
  const items: JSONContent[] = []
  let index = startIndex

  while (index < lines.length && /^\d+\. /.test(lines[index]!)) {
    const text = lines[index]!.replace(/^\d+\. /, '')
    items.push({
      type: 'listItem',
      content: [{ type: 'paragraph', content: parseInlineLine(text) }],
    })
    index += 1
  }

  return {
    node: { type: 'orderedList', content: items },
    nextIndex: index,
  }
}

export function deserializeMessageContent(content: string): MessageDocument {
  if (!content) {
    return { type: 'doc', content: [{ type: 'paragraph' }] }
  }

  const lines = content.split('\n')
  const blocks: JSONContent[] = []
  let paragraphLines: string[] = []
  let index = 0

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return
    blocks.push(paragraphFromLines(paragraphLines))
    paragraphLines = []
  }

  while (index < lines.length) {
    const line = lines[index]!

    if (line.startsWith('```')) {
      flushParagraph()
      const parsed = parseCodeBlock(lines, index)
      blocks.push(parsed.node)
      index = parsed.nextIndex
      continue
    }

    if (line.startsWith('> ')) {
      flushParagraph()
      const parsed = parseBlockquote(lines, index)
      blocks.push(parsed.node)
      index = parsed.nextIndex
      continue
    }

    if (/^[-*] /.test(line)) {
      flushParagraph()
      const parsed = parseBulletList(lines, index)
      blocks.push(parsed.node)
      index = parsed.nextIndex
      continue
    }

    if (/^\d+\. /.test(line)) {
      flushParagraph()
      const parsed = parseOrderedList(lines, index)
      blocks.push(parsed.node)
      index = parsed.nextIndex
      continue
    }

    const headingMatch = line.match(/^(#{1,6}) (.+)$/)
    if (headingMatch) {
      flushParagraph()
      blocks.push({
        type: 'heading',
        attrs: { level: headingMatch[1]!.length },
        content: parseInlineLine(headingMatch[2]!),
      })
      index += 1
      continue
    }

    if (line === '') {
      flushParagraph()
      index += 1
      continue
    }

    paragraphLines.push(line)
    index += 1
  }

  flushParagraph()

  if (blocks.length === 0) {
    return { type: 'doc', content: [{ type: 'paragraph' }] }
  }

  return { type: 'doc', content: blocks }
}
