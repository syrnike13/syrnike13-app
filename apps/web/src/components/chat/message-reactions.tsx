import type { Message, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import { EmojiPicker } from '#/components/emoji/emoji-picker'
import { CustomEmoji } from '#/components/emoji/custom-emoji'
import { SmilePlusIcon } from '#/components/icons'
import {
  MessageReaction,
  MessageReactionAdd,
  MessageReactions as MessageReactionsRow,
} from '@syrnike13/ui/primitives/message'
import { isCustomEmojiId } from '#/lib/emoji'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'

type MessageReactionsProps = {
  message: Message
  users: Record<string, User>
  currentUserId?: string
  serverId?: string
  onToggle: (emoji: string, active: boolean) => void
}

function ReactionEmoji({
  emoji,
  emojiName,
}: {
  emoji: string
  emojiName?: string
}) {
  if (isCustomEmojiId(emoji)) {
    return <CustomEmoji emojiId={emoji} name={emojiName} size="sm" />
  }
  if (emoji.length <= 8) {
    return <span className="text-base leading-none">{emoji}</span>
  }
  return <span>:{emojiName ?? emoji}:</span>
}

export function MessageReactions({
  message,
  users,
  currentUserId,
  serverId,
  onToggle,
}: MessageReactionsProps) {
  const t = useTranslations('chat')
  const emojis = useSyncStore((s) => s.emojis)
  const entries = Object.entries(message.reactions ?? {}).filter(
    ([, userIds]) => userIds.length > 0,
  )

  if (entries.length === 0) {
    return null
  }

  const reacted = (emoji: string) =>
    currentUserId
      ? (message.reactions?.[emoji] ?? []).includes(currentUserId)
      : false

  return (
    <MessageReactionsRow>
      {entries.map(([emoji, userIds]) => {
        const active = reacted(emoji)
        const names = userIds
          .map((id) => users[id]?.display_name ?? users[id]?.username ?? id)
          .join(', ')

        return (
          <MessageReaction
            key={emoji}
            pressed={active}
            onPressedChange={() => onToggle(emoji, active)}
            title={names}
            aria-label={t('reactionLabel', {
              emoji: emojis[emoji]?.name ?? emoji,
              count: userIds.length,
            })}
          >
            <ReactionEmoji emoji={emoji} emojiName={emojis[emoji]?.name} />
            {userIds.length}
          </MessageReaction>
        )
      })}
      <EmojiPicker
        serverId={serverId}
        align="start"
        onPick={(emoji) => onToggle(emoji, reacted(emoji))}
        trigger={
          <MessageReactionAdd
            title={t('addReaction')}
            aria-label={t('addReaction')}
          >
            <SmilePlusIcon />
          </MessageReactionAdd>
        }
      />
    </MessageReactionsRow>
  )
}
