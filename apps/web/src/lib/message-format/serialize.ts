import type { JSONContent } from '@tiptap/core'

import type { MessageDocument } from '#/lib/message-format/types'

const MARK_WRAP: Record<string, { open: string; close: string }> = {
  bold: { open: '**', close: '**' },
  italic: { open: '*', close: '*' },
  strike: { open: '~~', close: '~~' },
  spoiler: { open: '||', close: '||' },
  code: { open: '`', close: '`' },
}

function applyMark(text: string, markType: string): string {
  const wrap = MARK_WRAP[markType]
  if (!wrap) return text
  return `${wrap.open}${text}${wrap.close}`
}

function serializeMarkedText(text: string, marks: JSONContent['marks']): string {
  if (!marks?.length) return text

  const ordered = ['code', 'bold', 'italic', 'strike', 'spoiler', 'link']
  let result = text

  for (const markType of ordered) {
    const mark = marks.find((entry) => entry.type === markType)
    if (!mark) continue

    if (markType === 'link') {
      result = mark.attrs?.href ?? result
      continue
    }

    result = applyMark(result, markType)
  }

  return result
}

function serializeInlineNode(node: JSONContent): string {
  if (node.type === 'text') {
    return serializeMarkedText(node.text ?? '', node.marks)
  }

  if (node.type === 'hardBreak') {
    return '\n'
  }

  if (node.type === 'userMention') {
    return `<@${node.attrs?.id ?? ''}>`
  }

  if (node.type === 'roleMention') {
    return `<%${node.attrs?.id ?? ''}>`
  }

  if (node.type === 'channelMention') {
    return `<#${node.attrs?.id ?? ''}>`
  }

  if (node.type === 'massMention') {
    return node.attrs?.kind === 'online' ? '@online' : '@everyone'
  }

  if (node.type === 'customEmoji') {
    return `:${node.attrs?.id ?? ''}:`
  }

  return ''
}

function serializeParagraph(node: JSONContent): string {
  if (!node.content?.length) return ''
  return node.content.map(serializeInlineNode).join('')
}

function serializeBlockquote(node: JSONContent): string {
  const paragraphs = node.content ?? []
  return paragraphs
    .map((child) => {
      const line = serializeParagraph(child)
      return line
        .split('\n')
        .map((part) => `> ${part}`)
        .join('\n')
    })
    .join('\n')
}

function serializeBulletList(node: JSONContent): string {
  return (node.content ?? [])
    .map((item) => {
      const paragraph = item.content?.[0]
      return `- ${paragraph ? serializeParagraph(paragraph) : ''}`
    })
    .join('\n')
}

function serializeOrderedList(node: JSONContent): string {
  return (node.content ?? [])
    .map((item, index) => {
      const paragraph = item.content?.[0]
      return `${index + 1}. ${paragraph ? serializeParagraph(paragraph) : ''}`
    })
    .join('\n')
}

function serializeCodeBlock(node: JSONContent): string {
  const language = node.attrs?.language as string | undefined
  const text = node.content?.[0]?.text ?? ''
  const fence = language ? `\`\`\`${language}` : '```'
  return `${fence}\n${text}\n\`\`\``
}

function serializeHeading(node: JSONContent): string {
  const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)))
  return `${'#'.repeat(level)} ${serializeParagraph(node)}`
}

function serializeBlock(node: JSONContent): string {
  switch (node.type) {
    case 'paragraph':
      return serializeParagraph(node)
    case 'heading':
      return serializeHeading(node)
    case 'blockquote':
      return serializeBlockquote(node)
    case 'bulletList':
      return serializeBulletList(node)
    case 'orderedList':
      return serializeOrderedList(node)
    case 'codeBlock':
      return serializeCodeBlock(node)
    default:
      return ''
  }
}

function shouldJoinAdjacentListBlocks(
  previousType: JSONContent['type'] | undefined,
  nextType: JSONContent['type'] | undefined,
): boolean {
  return (
    (previousType === 'bulletList' && nextType === 'bulletList') ||
    (previousType === 'orderedList' && nextType === 'orderedList')
  )
}

export function serializeMessageContent(doc: MessageDocument): string {
  if (!doc.content?.length) return ''

  const blocks: string[] = []
  let previousType: JSONContent['type'] | undefined

  for (const node of doc.content) {
    const block = serializeBlock(node)
    if (!block.length) continue

    if (
      blocks.length > 0 &&
      shouldJoinAdjacentListBlocks(previousType, node.type)
    ) {
      blocks[blocks.length - 1] = `${blocks[blocks.length - 1]}\n${block}`
    } else {
      blocks.push(block)
    }

    previousType = node.type
  }

  return blocks.join('\n\n')
}
