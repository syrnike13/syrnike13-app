import type { Message as ApiMessage, File, User } from '@syrnike13/api-types'
import { reactToMessageEffect, unreactFromMessageEffect } from '@syrnike13/client/api/messages-api'
import { formatMessageTimeShort, messageCreatedAt } from '@syrnike13/client/lib/message-time'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import {
  Message,
  MessageAttachment,
  MessageAttachments,
  MessageAuthor,
  MessageAvatar,
  MessageContent,
  MessageHeader,
  MessageNote,
  MessageReaction,
  MessageReactionCount,
  MessageReactions,
  MessageReply,
  MessageText,
  MessageTimestamp,
} from '@syrnike13/ui-native/primitives/message'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Effect } from 'effect'
import { Image, Linking, Pressable, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { FileIcon } from '../components/icons/registry'
import { attachmentOriginalUrl, customEmojiUrl, formatFileSize, mediaUrl } from '../lib/media'
import { SystemRow } from './system-row'

/** Images in the feed are at most this wide (dp) and keep their aspect ratio. */
const IMAGE_MAX_WIDTH = 280
const IMAGE_MAX_HEIGHT = 320

/** Plain-text mentions until the feed renders markdown: <@id> becomes @name. */
export function withMentionNames(content: string | null | undefined, users: Record<string, User>) {
  return (content ?? '').replace(/<@([0-9A-Z]{26})>/g, (raw, id: string) => {
    const user = users[id]
    return user ? `@${user.display_name ?? user.username}` : raw
  })
}

function authorName(message: ApiMessage, author: User | undefined) {
  return message.masquerade?.name ?? author?.display_name ?? author?.username ?? '…'
}

/** One feed message: replies, author line (unless grouped), text, files, reactions. */
export function MessageRow({ message, compact }: { message: ApiMessage; compact: boolean }) {
  if (message.system) return <SystemRow message={message} system={message.system} />
  return <UserMessageRow message={message} compact={compact} />
}

function UserMessageRow({ message, compact }: { message: ApiMessage; compact: boolean }) {
  const t = useTranslations('mobile.chat')
  const { locale } = useLocale()
  const users = useSyncStore((state) => state.users)
  const author = users[message.author]
  const name = authorName(message, author)
  const text = withMentionNames(message.content, users)
  const hasReplies = Boolean(message.replies?.length)
  const showHeader = !compact || hasReplies

  return (
    <Message groupStart={showHeader}>
      {showHeader ? (
        <MessageAvatar>
          <Avatar size="lg" src={mediaUrl(author?.avatar)} name={name} />
        </MessageAvatar>
      ) : null}
      <MessageContent>
        {message.replies?.map((id) => (
          <ReplyQuote key={id} channelId={message.channel} messageId={id} />
        ))}
        {showHeader ? (
          <MessageHeader>
            <MessageAuthor>{name}</MessageAuthor>
            <MessageTimestamp>{formatMessageTimeShort(messageCreatedAt(message), locale)}</MessageTimestamp>
          </MessageHeader>
        ) : null}
        {text ? (
          <MessageText>
            {text}
            {message.edited ? <MessageNote> {t('edited')}</MessageNote> : null}
          </MessageText>
        ) : null}
        {message.attachments?.length ? (
          <MessageAttachments>
            {message.attachments.map((file) => (
              <Attachment key={file._id} file={file} />
            ))}
          </MessageAttachments>
        ) : null}
        <Reactions message={message} />
      </MessageContent>
    </Message>
  )
}

function ReplyQuote({ channelId, messageId }: { channelId: string; messageId: string }) {
  const t = useTranslations('mobile.chat')
  const original = useSyncStore((state) => state.messages[channelId]?.[messageId])
  const users = useSyncStore((state) => state.users)
  if (!original) {
    return (
      <MessageReply disabled>
        <Text className="italic">{t('replyUnavailable')}</Text>
      </MessageReply>
    )
  }
  const author = users[original.author]
  const excerpt = withMentionNames(original.content, users) || t('replyAttachment')
  return (
    <MessageReply disabled>
      <Avatar size="xs" src={mediaUrl(author?.avatar)} name={authorName(original, author)} />
      <Text className="font-medium text-foreground" numberOfLines={1}>
        {authorName(original, author)}
      </Text>
      <Text className="shrink" numberOfLines={1}>
        {excerpt}
      </Text>
    </MessageReply>
  )
}

function Attachment({ file }: { file: File }) {
  const t = useTranslations('mobile.chat')
  const { locale } = useLocale()
  const open = () => void Linking.openURL(attachmentOriginalUrl(file))

  if (file.metadata.type === 'Image' && file.metadata.width && file.metadata.height) {
    const scale = Math.min(1, IMAGE_MAX_WIDTH / file.metadata.width, IMAGE_MAX_HEIGHT / file.metadata.height)
    const size = { width: file.metadata.width * scale, height: file.metadata.height * scale }
    return (
      <Pressable accessibilityRole="imagebutton" accessibilityLabel={file.filename} onPress={open}>
        <MessageAttachment style={size}>
          <Image source={{ uri: mediaUrl(file) ?? undefined }} className="size-full" resizeMode="cover" />
        </MessageAttachment>
      </Pressable>
    )
  }

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={t('openAttachment', { name: file.filename })} onPress={open}>
      <MessageAttachment className="w-70 flex-row items-center gap-3 border border-border bg-card p-3">
        <FileIcon size={28} className="text-muted-foreground" />
        <View className="min-w-0 flex-1">
          <Text className="font-medium text-primary" numberOfLines={1}>
            {file.filename}
          </Text>
          <Text className="text-xs text-muted-foreground">{formatFileSize(file.size, locale)}</Text>
        </View>
      </MessageAttachment>
    </Pressable>
  )
}

/** Discord's reaction chips; tapping one adds or removes your reaction. */
function Reactions({ message }: { message: ApiMessage }) {
  const t = useTranslations('mobile.chat')
  const { session } = useSession()
  const entries = Object.entries(message.reactions ?? {}).filter(([, userIds]) => userIds.length > 0)
  if (!entries.length) return null

  function toggle(emoji: string, reacted: boolean) {
    const request = reacted ? unreactFromMessageEffect : reactToMessageEffect
    // The gateway's MessageReact/MessageUnreact event updates the store.
    Effect.runFork(request(session.token, message.channel, message._id, emoji).pipe(Effect.ignore))
  }

  return (
    <MessageReactions>
      {entries.map(([emoji, userIds]) => {
        const reacted = userIds.includes(session.userId)
        const custom = customEmojiUrl(emoji)
        return (
          <MessageReaction
            key={emoji}
            pressed={reacted}
            accessibilityLabel={t('reaction', { emoji, count: userIds.length })}
            onPress={() => toggle(emoji, reacted)}
          >
            {custom ? (
              <Image source={{ uri: custom }} className="size-5" resizeMode="contain" />
            ) : (
              <Text className="text-lg leading-5">{emoji}</Text>
            )}
            <MessageReactionCount className={reacted ? 'text-foreground' : undefined}>{userIds.length}</MessageReactionCount>
          </MessageReaction>
        )
      })}
    </MessageReactions>
  )
}
