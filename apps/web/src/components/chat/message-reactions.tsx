import type { Message, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import { MessageReactionPicker } from '#/components/chat/message-reaction-picker'
import { Button } from '@syrnike13/ui/primitives/button'
import { CustomEmoji } from '#/components/emoji/custom-emoji'
import { isCustomEmojiId } from '#/lib/emoji'
import { useSyncStore } from '#/features/sync/sync-store'
import { SmilePlusIcon } from '#/components/icons'

type MessageReactionsProps = {
  message: Message
  users: Record<string, User>
  currentUserId?: string
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
    return <span>{emoji}</span>
  }
  return <span>:{emojiName ?? emoji}:</span>
}

export function MessageReactions({
  message,
  users,
  currentUserId,
  onToggle,
}: MessageReactionsProps) {
  const t = useTranslations('chat')
  const emojis = useSyncStore((s) => s.emojis)
  const entries = Object.entries(message.reactions ?? {})

  if (entries.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([emoji, userIds]) => {
        const active = currentUserId
          ? userIds.includes(currentUserId)
          : false

        return (
          <Button
            key={emoji}
            type="button"
            variant={active ? 'secondary' : 'outline'}
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => onToggle(emoji, active)}
            title={userIds
              .map((id) => users[id]?.username ?? id)
              .join(', ')}
          >
            <ReactionEmoji emoji={emoji} emojiName={emojis[emoji]?.name} />
            <span className="tabular-nums text-muted-foreground">
              {userIds.length}
            </span>
          </Button>
        )
      })}
      <MessageReactionPicker
        onPick={(emoji) => {
          const active = currentUserId
            ? (message.reactions?.[emoji] ?? []).includes(currentUserId)
            : false
          onToggle(emoji, active)
        }}
        align="start"
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="size-7 px-0"
            title={t('addReaction')}
          >
            <SmilePlusIcon className="size-3.5" />
          </Button>
        }
      />
    </div>
  )
}
