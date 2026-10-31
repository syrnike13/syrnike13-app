import type { Message as ApiMessage, User } from '@syrnike13/api-types'
import { fetchChannelMessagesEffect, sendChannelMessageEffect } from '@syrnike13/client/api/messages-api'
import { ackChannelEffect } from '@syrnike13/client/api/sync-api'
import { buildMessageFeedItems, type MessageFeedItem } from '@syrnike13/client/lib/message-feed'
import {
  formatDateDividerDate,
  formatMessageTimeShort,
  messageCreatedAt,
} from '@syrnike13/client/lib/message-time'
import { randomUuid } from '@syrnike13/client/lib/random-uuid'
import { getChannelLabel } from '@syrnike13/client/sync/channel-label'
import { getChannelMessages } from '@syrnike13/client/sync/selectors'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Input } from '@syrnike13/ui-native/primitives/input'
import {
  Message,
  MessageAuthor,
  MessageAvatar,
  MessageContent,
  MessageHeader,
  MessageText,
  MessageTimestamp,
} from '@syrnike13/ui-native/primitives/message'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Effect } from 'effect'
import { router } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { FlatList, KeyboardAvoidingView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useSession } from '../auth/session-context'
import { ArrowUpIcon, ChevronLeftIcon, HashIcon } from '../components/icons/registry'
import { mediaUrl } from '../lib/media'

/** A text channel or DM: header, newest-at-bottom feed and composer. */
export function ChatScreen({ channelId }: { channelId: string }) {
  const t = useTranslations('mobile.chat')
  const tChannels = useTranslations('mobile.channels')
  const { locale } = useLocale()
  const { session } = useSession()
  const channel = useSyncStore((state) => state.channels[channelId])
  const users = useSyncStore((state) => state.users)
  const messages = useSyncStore((state) => getChannelMessages(state, channelId))
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    Effect.runPromise(fetchChannelMessagesEffect(session.token, channelId)).then(
      ({ messages: page, users: authors }) => {
        syncStore.upsertUsers(authors)
        syncStore.setChannelMessages(channelId, page)
      },
      () => setLoadFailed(true),
    )
  }, [channelId, session.token])

  // Reading the channel on this screen marks it read up to the newest message.
  const lastId = messages.at(-1)?._id
  useEffect(() => {
    if (!lastId) return
    syncStore.setChannelLastRead(channelId, lastId)
    Effect.runFork(ackChannelEffect(session.token, channelId, lastId).pipe(Effect.ignore))
  }, [channelId, lastId, session.token])

  const items = useMemo(
    () =>
      buildMessageFeedItems(messages, {
        formatDateLabel: (date) => formatDateDividerDate(date, locale),
      }).reverse(),
    [locale, messages],
  )

  const isDm = channel?.channel_type === 'DirectMessage' || channel?.channel_type === 'Group'
  const title = channel ? getChannelLabel(channel, users, session.userId, tChannels) : ''

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      <View className="h-12 flex-row items-center gap-1 border-b border-border px-2">
        <Button variant="ghost" size="icon" accessibilityLabel={t('back')} onPress={() => router.back()}>
          <ChevronLeftIcon size={24} />
        </Button>
        {isDm ? null : <HashIcon className="text-muted-foreground" />}
        <Text className="flex-1 text-base font-semibold" numberOfLines={1}>
          {title}
        </Text>
      </View>
      <FlatList
        inverted
        className="flex-1"
        contentContainerClassName="pb-4"
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <FeedRow item={item} users={users} locale={locale} />}
        ListFooterComponent={
          loadFailed ? <Text className="p-4 text-center text-destructive">{t('loadFailed')}</Text> : undefined
        }
      />
      <Composer channelId={channelId} placeholder={t('placeholder', { channel: title })} />
    </KeyboardAvoidingView>
  )
}

function FeedRow({ item, users, locale }: { item: MessageFeedItem; users: Record<string, User>; locale: string }) {
  if (item.type === 'date') {
    return (
      <View className="mt-4 flex-row items-center gap-2 px-4">
        <View className="h-px flex-1 bg-border" />
        <Text className="text-xs font-medium text-muted-foreground">{item.dateLabel}</Text>
        <View className="h-px flex-1 bg-border" />
      </View>
    )
  }
  if (item.type !== 'message') return null
  return <FeedMessage message={item.message} compact={item.compact} author={users[item.message.author]} locale={locale} />
}

function FeedMessage({
  message,
  compact,
  author,
  locale,
}: {
  message: ApiMessage
  compact: boolean
  author: User | undefined
  locale: string
}) {
  const name = message.masquerade?.name ?? author?.display_name ?? author?.username ?? '…'
  if (compact) {
    return (
      <Message>
        <MessageContent>
          <MessageText>{message.content}</MessageText>
        </MessageContent>
      </Message>
    )
  }
  return (
    <Message groupStart>
      <MessageAvatar>
        <Avatar size="lg" src={mediaUrl(author?.avatar)} name={name} />
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>
          <MessageAuthor>{name}</MessageAuthor>
          <MessageTimestamp>{formatMessageTimeShort(messageCreatedAt(message), locale)}</MessageTimestamp>
        </MessageHeader>
        {message.content ? <MessageText>{message.content}</MessageText> : null}
      </MessageContent>
    </Message>
  )
}

function Composer({ channelId, placeholder }: { channelId: string; placeholder: string }) {
  const t = useTranslations('mobile.chat')
  const { session } = useSession()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const insets = useSafeAreaInsets()

  async function send() {
    const content = text.trim()
    if (!content) return
    setSending(true)
    try {
      const message = await Effect.runPromise(
        sendChannelMessageEffect(session.token, channelId, { content, nonce: randomUuid() }),
      )
      syncStore.upsertMessage(message)
      setText('')
    } catch {
      // The draft stays in the field so the user can retry.
    } finally {
      setSending(false)
    }
  }

  return (
    // Outside the tab bar, the composer sits on the system gesture area.
    <View className="flex-row items-end gap-2 border-t border-border px-3 pt-2" style={{ paddingBottom: insets.bottom + 8 }}>
      <Input
        className="max-h-32 flex-1"
        multiline
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
      />
      <Button
        size="icon-lg"
        shape="circle"
        accessibilityLabel={t('send')}
        disabled={sending || !text.trim()}
        onPress={send}
      >
        <ArrowUpIcon className="text-primary-foreground" />
      </Button>
    </View>
  )
}
