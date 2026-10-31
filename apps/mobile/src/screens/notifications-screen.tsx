import type { Message as ApiMessage } from '@syrnike13/api-types'
import { fetchChannelMessageEffect } from '@syrnike13/client/api/messages-api'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Effect, Fiber } from 'effect'
import { router } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { withMentionNames } from '../chat/message-row'
import { ArrowLeftIcon } from '../components/icons/registry'
import { displayName } from '../lib/presence'
import { mediaUrl } from '../lib/media'
import { shortAge } from '../lib/relative-time'

/** Newest mentions shown; older ones stay reachable from their channels. */
const MENTION_LIMIT = 50

type Mention = { channelId: string; messageId: string }

/** Unread mentions across every channel, newest first (ULIDs sort by time). */
function useUnreadMentions() {
  const unreads = useSyncStore((state) => state.unreads)
  return useMemo(
    () =>
      Object.entries(unreads)
        .flatMap(([channelId, unread]) => unread.mentions.map((messageId) => ({ channelId, messageId })))
        .sort((a, b) => b.messageId.localeCompare(a.messageId))
        .slice(0, MENTION_LIMIT),
    [unreads],
  )
}

/**
 * Discord's notifications page, opened from the bell on the user bar: who
 * mentioned you where, with the message quoted. Tapping a row opens it.
 */
export function NotificationsScreen() {
  const t = useTranslations('mobile.notifications')
  const { session } = useSession()
  const mentions = useUnreadMentions()
  const [messages, setMessages] = useState<Record<string, ApiMessage>>({})

  // Mentions are message ids; fetch the ones not loaded yet.
  useEffect(() => {
    const missing = mentions.filter((mention) => !messages[mention.messageId])
    if (!missing.length) return
    const fiber = Effect.runFork(
      Effect.forEach(
        missing,
        (mention) =>
          fetchChannelMessageEffect(session.token, mention.channelId, mention.messageId).pipe(
            Effect.option,
          ),
        { concurrency: 4 },
      ).pipe(
        Effect.tap((results) =>
          Effect.sync(() =>
            setMessages((current) => {
              const next = { ...current }
              for (const result of results) {
                if (result._tag === 'Some') next[result.value._id] = result.value
              }
              return next
            }),
          ),
        ),
      ),
    )
    return () => void Effect.runFork(Fiber.interrupt(fiber))
    // Loaded messages are read, not watched: only new mentions need a fetch.
  }, [mentions, session.token])

  return (
    <View className="flex-1 bg-background">
      <View className="h-14 flex-row items-center gap-2 border-b border-border pr-4 pl-2">
        <Button variant="ghost" size="icon-lg" accessibilityLabel={t('back')} onPress={() => router.back()}>
          <ArrowLeftIcon size={24} />
        </Button>
        <Text className="text-2xl font-bold">{t('title')}</Text>
      </View>
      <FlatList
        data={mentions}
        keyExtractor={(mention) => mention.messageId}
        contentContainerClassName="pb-8"
        ListHeaderComponent={
          mentions.length ? (
            <Text className="px-4 pt-4 pb-2 text-sm font-medium text-muted-foreground">{t('unreadMentions')}</Text>
          ) : undefined
        }
        ListEmptyComponent={<Text className="p-8 text-center text-muted-foreground">{t('empty')}</Text>}
        renderItem={({ item }) => <MentionRow mention={item} message={messages[item.messageId]} />}
      />
    </View>
  )
}

function MentionRow({ mention, message }: { mention: Mention; message: ApiMessage | undefined }) {
  const t = useTranslations('mobile.notifications')
  const tTime = useTranslations('mobile.time')
  const users = useSyncStore((state) => state.users)
  const place = useSyncStore((state) => {
    const channel = state.channels[mention.channelId]
    if (!channel) return ''
    if (channel.channel_type === 'TextChannel') {
      const server = state.servers[channel.server]
      return `${server?.name ?? ''} — #${channel.name}`
    }
    return 'name' in channel ? channel.name : ''
  })
  const author = message ? users[message.author] : undefined
  const name = message?.masquerade?.name || displayName(author) || '…'
  const age = shortAge(mention.messageId)

  return (
    <Pressable
      className="flex-row gap-3 px-4 py-3 active:bg-hover"
      onPress={() => router.push(`/channel/${mention.channelId}`)}
    >
      <Avatar size="xl" src={mediaUrl(author?.avatar)} name={name} />
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-start gap-2">
          <Text className="flex-1" numberOfLines={2}>
            <Text className="font-semibold">{name}</Text>
            {` ${place ? t('mentionedYouIn', { place }) : t('mentionedYou')}`}
          </Text>
          <Text className="text-xs text-muted-foreground">{tTime(age.key, { count: age.count })}</Text>
        </View>
        {message?.content ? (
          <View className="border-l-4 border-border pl-2">
            <Text className="text-muted-foreground" numberOfLines={3}>
              {withMentionNames(message.content, users)}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  )
}
