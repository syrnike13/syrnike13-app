import type {
  BulkMessageResponse,
  DataEditMessage,
  DataMessageSearch,
  DataMessageSend,
  Message,
  User,
} from '@syrnike13/api-types'

import { encodeReactionId } from '#/lib/reactions'

import { apiRequest } from '#/lib/api/client'

export function normalizeMessagesResponse(response: BulkMessageResponse): {
  messages: Message[]
  users: User[]
} {
  if (Array.isArray(response)) {
    return {
      messages: response.filter((message): message is Message =>
        Boolean(message),
      ),
      users: [],
    }
  }
  const payload = response as { messages?: Message[]; users?: User[] }
  return {
    messages: payload.messages ?? [],
    users: payload.users ?? [],
  }
}

export const MESSAGE_PAGE_SIZE = 50

export type FetchChannelMessagesOptions = {
  limit?: number
  /** Загрузить сообщения старше указанного id */
  before?: string
  /** Только закреплённые сообщения */
  pinned?: boolean
}

export async function fetchChannelMessages(
  token: string,
  channelId: string,
  options: FetchChannelMessagesOptions = {},
) {
  const limit = options.limit ?? MESSAGE_PAGE_SIZE
  const query = new URLSearchParams({
    limit: String(limit),
    sort: 'Latest',
    include_users: 'true',
  })

  if (options.before) {
    query.set('before', options.before)
  }

  if (options.pinned) {
    query.set('pinned', 'true')
  }

  const response = await apiRequest<BulkMessageResponse>(
    `/channels/${channelId}/messages?${query}`,
    { token },
  )

  const { messages, users } = normalizeMessagesResponse(response)
  return {
    messages: [...messages].sort((a, b) => a._id.localeCompare(b._id)),
    users,
  }
}

export type SendMessageInput = {
  content?: string
  attachments?: string[]
  replies?: Array<{ id: string; mention: boolean }>
}

export async function sendChannelMessage(
  token: string,
  channelId: string,
  input: SendMessageInput,
) {
  const body: DataMessageSend = {}

  if (input.content?.trim()) {
    body.content = input.content.trim()
  }

  if (input.attachments?.length) {
    body.attachments = input.attachments
  }

  if (input.replies?.length) {
    body.replies = input.replies
  }

  if (!body.content && !body.attachments?.length) {
    throw new Error('Пустое сообщение')
  }

  return apiRequest<Message>(`/channels/${channelId}/messages`, {
    method: 'POST',
    token,
    body,
  })
}

export async function searchChannelMessages(
  token: string,
  channelId: string,
  query: string,
  limit = 25,
) {
  const body: DataMessageSearch = {
    query,
    limit,
    include_users: true,
  }

  const response = await apiRequest<BulkMessageResponse>(
    `/channels/${channelId}/search`,
    {
      method: 'POST',
      token,
      body,
    },
  )

  return normalizeMessagesResponse(response)
}

export async function editChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
  content: string,
) {
  const body: DataEditMessage = { content: content.trim() }

  return apiRequest<Message>(
    `/channels/${channelId}/messages/${messageId}`,
    { method: 'PATCH', token, body },
  )
}

export async function deleteChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
) {
  return apiRequest<void>(
    `/channels/${channelId}/messages/${messageId}`,
    { method: 'DELETE', token },
  )
}

export async function reactToMessage(
  token: string,
  channelId: string,
  messageId: string,
  emoji: string,
) {
  return apiRequest(
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeReactionId(emoji)}`,
    { method: 'PUT', token },
  )
}

export async function fetchChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
) {
  return apiRequest<Message>(
    `/channels/${channelId}/messages/${messageId}`,
    { token },
  )
}

export async function fetchPinnedMessages(
  token: string,
  channelId: string,
  limit = 50,
) {
  const body: DataMessageSearch = {
    pinned: true,
    limit,
    sort: 'Latest',
    include_users: true,
  }

  const response = await apiRequest<BulkMessageResponse>(
    `/channels/${channelId}/search`,
    {
      method: 'POST',
      token,
      body,
    },
  )

  const { messages, users } = normalizeMessagesResponse(response)
  return {
    messages: [...messages].filter((message) => message.pinned).sort((a, b) =>
      a._id.localeCompare(b._id),
    ),
    users,
  }
}

export async function pinChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
) {
  return apiRequest<void>(
    `/channels/${channelId}/messages/${messageId}/pin`,
    { method: 'POST', token },
  )
}

export async function unpinChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
) {
  return apiRequest<void>(
    `/channels/${channelId}/messages/${messageId}/pin`,
    { method: 'DELETE', token },
  )
}

export async function unreactFromMessage(
  token: string,
  channelId: string,
  messageId: string,
  emoji: string,
) {
  return apiRequest(
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeReactionId(emoji)}`,
    { method: 'DELETE', token },
  )
}

export async function clearMessageReactions(
  token: string,
  channelId: string,
  messageId: string,
) {
  return apiRequest<void>(
    `/channels/${channelId}/messages/${messageId}/reactions`,
    { method: 'DELETE', token },
  )
}
