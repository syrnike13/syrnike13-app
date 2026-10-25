import type { Channel, Role, User } from '@syrnike13/api-types'

import { parseInlineLine } from '#/lib/message-format/inline-parse'

type PreviewContext = {
  users: Record<string, User | undefined>
  channels?: Record<string, Channel | undefined>
  roles?: Record<string, Role | undefined>
  emojis?: Record<string, { name: string } | undefined>
}

/**
 * One-line plain text of a message for previews (reply strip, search):
 * mentions read as @name / #channel / @role, custom emoji as :name:, and
 * formatting marks are dropped.
 */
export function messagePreviewText(content: string, context: PreviewContext): string {
  const line = content.replace(/\s+/g, ' ').trim()
  return parseInlineLine(line)
    .map((node) => {
      const id = typeof node.attrs?.id === 'string' ? node.attrs.id : ''
      switch (node.type) {
        case 'userMention': {
          const user = context.users[id]
          return `@${user?.display_name ?? user?.username ?? id}`
        }
        case 'channelMention': {
          const channel = context.channels?.[id]
          return `#${channel && 'name' in channel ? channel.name : id}`
        }
        case 'roleMention':
          return `@${context.roles?.[id]?.name ?? id}`
        case 'customEmoji':
          return `:${context.emojis?.[id]?.name ?? 'emoji'}:`
        case 'massMention':
          return node.attrs?.kind === 'online' ? '@online' : '@everyone'
        default:
          return node.text ?? ''
      }
    })
    .join('')
}
