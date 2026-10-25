import type {
  DataEditMessage,
  DataMessageSearch,
  DataMessageSend,
  Message,
  User,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'

import { encodeReactionId } from '#/lib/reactions'

import { apiRequestEffect } from '#/lib/api/client'

type MessagesResponse =
  | Message[]
  | {
      messages: Message[]
      users: User[]
    }

export function normalizeMessagesResponse(response: MessagesResponse): {
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
  return {
    messages: [...response.messages],
    users: [...response.users],
  }
}

export const MESSAGE_PAGE_SIZE = 50

export type FetchChannelMessagesOptions = {
  limit?: number
  /** Загрузить сообщения старше указанного id */
  before?: string
  /** Только закреплённые сообщения */
  pinned?: boolean
  signal?: AbortSignal
}

type FetchChannelMessagesEffectOptions = Omit<
  FetchChannelMessagesOptions,
  'signal'
>

export const fetchChannelMessagesEffect = Effect.fn(
  'web.messages.fetchChannel',
)(function*(
  token: string,
  channelId: string,
  options: FetchChannelMessagesEffectOptions = {},
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

  const response = yield* apiRequestEffect(
    `/channels/${channelId}/messages?${query}`,
    ApiSchema.MessageQueryQuery200,
    { token },
  )

  const { messages, users } = normalizeMessagesResponse(response)
  return {
    messages: [...messages].sort((a, b) => a._id.localeCompare(b._id)),
    users,
  }
})

export type SendMessageInput = {
  nonce?: string
  content?: string
  attachments?: string[]
  replies?: Array<{ id: string; mention: boolean }>
}

export const sendChannelMessageEffect = Effect.fn('web.messages.send')(
  function*(token: string, channelId: string, input: SendMessageInput) {
    const body: DataMessageSend = {}

    if (input.nonce) {
      body.nonce = input.nonce
    }

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
      return yield* Effect.fail(new Error('Пустое сообщение'))
    }

    return yield* apiRequestEffect(
      `/channels/${channelId}/messages`,
      ApiSchema.MessageSendMessageSend200,
      {
        method: 'POST',
        token,
        body,
      },
    )
  },
)

export function sendChannelMessage(
  token: string,
  channelId: string,
  input: SendMessageInput,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    sendChannelMessageEffect(token, channelId, input),
    signal ? { signal } : undefined,
  )
}

export const searchChannelMessagesEffect = Effect.fn('web.messages.search')(
  function*(
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

    const response = yield* apiRequestEffect(
      `/channels/${channelId}/search`,
      ApiSchema.MessageSearchSearch200,
      {
        method: 'POST',
        token,
        body,
      },
    )

    return normalizeMessagesResponse(response)
  },
)

export const editChannelMessageEffect = Effect.fn('web.messages.edit')(
  function*(
    token: string,
    channelId: string,
    messageId: string,
    content: string,
  ) {
    const body: DataEditMessage = { content: content.trim() }

    return yield* apiRequestEffect(
      `/channels/${channelId}/messages/${messageId}`,
      ApiSchema.MessageEditEdit200,
      { method: 'PATCH', token, body },
    )
  },
)

export const deleteChannelMessageEffect = Effect.fn('web.messages.delete')(
  function*(token: string, channelId: string, messageId: string) {
    return yield* apiRequestEffect(
      `/channels/${channelId}/messages/${messageId}`,
      Schema.Void,
      { method: 'DELETE', token },
    )
  },
)

export const reactToMessageEffect = Effect.fn('web.messages.react')(
  function*(
    token: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ) {
    return yield* apiRequestEffect(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeReactionId(emoji)}`,
      Schema.Void,
      { method: 'PUT', token },
    )
  },
)

export const fetchChannelMessageEffect = Effect.fn('web.messages.fetchOne')(
  function*(token: string, channelId: string, messageId: string) {
    return yield* apiRequestEffect(
      `/channels/${channelId}/messages/${messageId}`,
      ApiSchema.MessageFetchFetch200,
      { token },
    )
  },
)

export const fetchPinnedMessagesEffect = Effect.fn(
  'web.messages.fetchPinned',
)(function*(token: string, channelId: string, limit = 50) {
  const body: DataMessageSearch = {
    pinned: true,
    limit,
    sort: 'Latest',
    include_users: true,
  }

  const response = yield* apiRequestEffect(
    `/channels/${channelId}/search`,
    ApiSchema.MessageSearchSearch200,
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
})

export const pinChannelMessageEffect = Effect.fn('web.messages.pin')(
  function*(token: string, channelId: string, messageId: string) {
    return yield* apiRequestEffect(
      `/channels/${channelId}/messages/${messageId}/pin`,
      Schema.Void,
      { method: 'POST', token },
    )
  },
)

export const unpinChannelMessageEffect = Effect.fn('web.messages.unpin')(
  function*(token: string, channelId: string, messageId: string) {
    return yield* apiRequestEffect(
      `/channels/${channelId}/messages/${messageId}/pin`,
      Schema.Void,
      { method: 'DELETE', token },
    )
  },
)

export const unreactFromMessageEffect = Effect.fn('web.messages.unreact')(
  function*(
    token: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ) {
    return yield* apiRequestEffect(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeReactionId(emoji)}`,
      Schema.Void,
      { method: 'DELETE', token },
    )
  },
)
