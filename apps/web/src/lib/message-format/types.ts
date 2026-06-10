import type { JSONContent } from '@tiptap/core'
import type { Channel, Emoji, Member, Role, Server, User } from '@syrnike13/api-types'

export type MessageFormatContext = {
  users?: Record<string, User>
  members?: Record<string, Member>
  emojis?: Record<string, Emoji>
  roles?: Record<string, Role>
  channels?: Record<string, Channel>
  server?: Server
  serverId?: string
  serverName?: string
  currentUserId?: string
}

export type MessageDocument = JSONContent

export type InlineMatchType =
  | 'link'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'spoiler'
  | 'mass'
  | 'userMention'
  | 'roleMention'
  | 'channelMention'
  | 'customEmoji'

export type InlineMatch = {
  index: number
  length: number
  type: InlineMatchType
  full: string
  inner: string
  id?: string
}
