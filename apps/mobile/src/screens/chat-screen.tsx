import {
  fetchChannelMessagesEffect,
  MESSAGE_PAGE_SIZE,
  sendChannelMessageEffect,
} from '@syrnike13/client/api/messages-api'
import { ackChannelEffect } from '@syrnike13/client/api/sync-api'
import { buildMessageFeedItems, type MessageFeedItem } from '@syrnike13/client/lib/message-feed'
import { formatDateDividerDate } from '@syrnike13/client/lib/message-time'
import { randomUuid } from '@syrnike13/client/lib/random-uuid'
import { useTypingIndicator } from '@syrnike13/client/gateway/use-typing-indicator'
import { getChannelLabel, getDmRecipientId } from '@syrnike13/client/sync/channel-label'
import { getChannelMessages } from '@syrnike13/client/sync/selectors'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Input } from '@syrnike13/ui-native/primitives/input'
import { MessageDivider } from '@syrnike13/ui-native/primitives/message'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Effect } from 'effect'
import { router } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, KeyboardAvoidingView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useSession } from '../auth/session-context'
import { MessageRow } from '../chat/message-row'
import { eventsGateway } from '../data/gateway'
import { ArrowLeftIcon, ArrowUpIcon, ChevronRightIcon, HashIcon } from '../components/icons/registry'
import { mediaUrl } from '../lib/media'
import { userStatus } from '../lib/presence'

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
  // Whether the server may have messages older than the oldest one loaded.
  const [hasOlder, setHasOlder] = useState(true)
  const loadingOlder = useRef(false)

  useEffect(() => {
    setHasOlder(true)
    Effect.runPromise(fetchChannelMessagesEffect(session.token, channelId)).then(
      ({ messages: page, users: authors }) => {
        syncStore.upsertUsers(authors)
        syncStore.setChannelMessages(channelId, page)
        setHasOlder(page.length >= MESSAGE_PAGE_SIZE)
      },
      () => setLoadFailed(true),
    )
  }, [channelId, session.token])

  const oldestId = messages[0]?._id
  function loadOlder() {
    if (!hasOlder || !oldestId || loadingOlder.current) return
    loadingOlder.current = true
    Effect.runPromise(fetchChannelMessagesEffect(session.token, channelId, { before: oldestId }))
      .then(({ messages: page, users: authors }) => {
        syncStore.upsertUsers(authors)
        syncStore.prependChannelMessages(channelId, page)
        setHasOlder(page.length >= MESSAGE_PAGE_SIZE)
      })
      .catch(() => {})
      .finally(() => {
        loadingOlder.current = false
      })
  }

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
  const recipient = channel ? users[getDmRecipientId(channel, session.userId) ?? ''] : undefined

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      {/* 56dp header: back 40, then `# channel ›` or the DM partner. */}
      <View className="h-14 flex-row items-center gap-2 border-b border-border pr-4 pl-2">
        <Button variant="ghost" size="icon-lg" accessibilityLabel={t('back')} onPress={() => router.back()}>
          <ArrowLeftIcon size={24} />
        </Button>
        {isDm ? (
          <Avatar size="default" src={mediaUrl(recipient?.avatar)} name={title} status={userStatus(recipient)} />
        ) : (
          <HashIcon size={18} className="text-muted-foreground" />
        )}
        <Text className="shrink text-lg font-semibold" numberOfLines={1}>
          {title}
        </Text>
        <ChevronRightIcon size={16} className="text-muted-foreground" />
      </View>
      <FlatList
        inverted
        className="flex-1"
        contentContainerClassName="pb-4"
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <FeedRow item={item} />}
        // The list is inverted, so its end is the top: the oldest messages.
        onEndReached={loadOlder}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          loadFailed ? <Text className="p-4 text-center text-destructive">{t('loadFailed')}</Text> : undefined
        }
      />
      <TypingLine channelId={channelId} />
      <Composer channelId={channelId} placeholder={t('placeholder', { channel: title })} />
    </KeyboardAvoidingView>
  )
}

function FeedRow({ item }: { item: MessageFeedItem }) {
  if (item.type === 'date') return <MessageDivider label={item.dateLabel} />
  if (item.type !== 'message') return null
  return <MessageRow message={item.message} compact={item.compact} />
}

/** "Name is typing…" above the composer; your own typing is not shown. */
function TypingLine({ channelId }: { channelId: string }) {
  const t = useTranslations('mobile.chat.typing')
  const { session } = useSession()
  const typing = useSyncStore((state) => state.typingUsers[channelId])
  const users = useSyncStore((state) => state.users)
  const names = (typing ?? [])
    .filter((id) => id !== session.userId)
    .map((id) => users[id]?.display_name ?? users[id]?.username ?? t('someone'))
  const label =
    names.length === 0
      ? ''
      : names.length === 1
        ? t('one', { name: names[0] })
        : names.length === 2
          ? t('two', { first: names[0], second: names[1] })
          : t('many')
  // Always reserve the line so the feed does not jump when someone types.
  return (
    <Text className="h-5 px-4 text-xs leading-5 font-medium text-muted-foreground" numberOfLines={1}>
      {label}
    </Text>
  )
}

function Composer({ channelId, placeholder }: { channelId: string; placeholder: string }) {
  const t = useTranslations('mobile.chat')
  const { session } = useSession()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const insets = useSafeAreaInsets()
  const { notifyTyping, stopTyping } = useTypingIndicator(eventsGateway, channelId)

  async function send() {
    const content = text.trim()
    if (!content) return
    setSending(true)
    stopTyping()
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
    // Discord's floating pill, 16 from the edges, above the system gesture area.
    <View className="px-4 pt-2" style={{ paddingBottom: insets.bottom + 8 }}>
      <View className="min-h-14.5 flex-row items-end gap-1 rounded-3xl bg-card px-3 py-2">
        <Input
          variant="bare"
          className="max-h-32 flex-1"
          multiline
          value={text}
          onChangeText={(value) => {
            setText(value)
            if (value) notifyTyping()
          }}
          placeholder={placeholder}
        />
        {text.trim() ? (
          <Button size="icon-lg" shape="circle" accessibilityLabel={t('send')} disabled={sending} onPress={send}>
            <ArrowUpIcon className="text-primary-foreground" />
          </Button>
        ) : null}
      </View>
    </View>
  )
}
