import type { Member, Message, Server, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { XIcon } from '#/components/icons'

import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '@syrnike13/ui/primitives/button'
import { MessageReply } from '@syrnike13/ui/primitives/message'
import { Toggle } from '@syrnike13/ui/primitives/toggle'
import { memberRoleEntries } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
import { messagePreviewText } from '#/lib/message-format/preview-text'

export function messageAuthorName(
  message: Message,
  users: Record<string, User>,
  fallback: string,
) {
  const masqueradeName = message.masquerade?.name?.trim()
  if (masqueradeName) return masqueradeName
  const webhookName = message.webhook?.name?.trim()
  if (webhookName) return webhookName
  if (message.user) {
    return message.user.display_name ?? message.user.username
  }
  const user = users[message.author]
  return user?.display_name ?? user?.username ?? fallback
}

function replyAuthorColor(
  serverId: string | undefined,
  message: Message,
  members: Record<string, Member>,
  servers: Record<string, Server>,
): string | undefined {
  if (!serverId) return undefined
  const server = servers[serverId]
  const member = members[`${serverId}:${message.author}`]
  if (!server || !member) return undefined

  for (const role of memberRoleEntries(server, member)) {
    if (!role.colour) continue
    const colour = role.colour.trim()
    return colour.startsWith('#') ? colour : `#${colour}`
  }
  return undefined
}

/** Цитата ответа в ленте: мини-аватар, имя, превью. Уголок рисует MessageReply. */
export function InlineReplyQuote({
  replyId,
  messagesById,
  users,
  serverId,
  onJump,
}: {
  replyId: string
  messagesById: Record<string, Message>
  users: Record<string, User>
  serverId?: string
  onJump?: (messageId: string) => void
}) {
  const t = useTranslations('chat')
  const members = useSyncStore((s) => s.members)
  const servers = useSyncStore((s) => s.servers)
  const channels = useSyncStore((s) => s.channels)
  const emojis = useSyncStore((s) => s.emojis)

  const original = messagesById[replyId]
  if (!original) {
    return (
      <MessageReply>
        <span className="italic">{t('replyToDeleted')}</span>
      </MessageReply>
    )
  }

  const name = messageAuthorName(original, users, t('messageLabel'))
  const replyUser = original.user ?? users[original.author]
  const snippet =
    (original.content
      ? messagePreviewText(original.content, {
          users,
          channels,
          emojis,
          roles: serverId ? servers[serverId]?.roles : undefined,
        }).slice(0, 100)
      : '') || t('attachmentPreview')
  const nameColor = replyAuthorColor(serverId, original, members, servers)

  return (
    <MessageReply
      render={
        onJump ? (
          <button type="button" onClick={() => onJump(replyId)} />
        ) : undefined
      }
    >
      {replyUser ? (
        <UserAvatar
          user={replyUser}
          className="size-4 shrink-0"
          fallbackClassName="size-4 text-3xs"
          showPresence={false}
        />
      ) : null}
      <span
        className={cn(
          'shrink-0 font-medium',
          nameColor ? 'text-(--reply-name-color)' : 'text-foreground',
        )}
        style={
          nameColor
            ? ({ '--reply-name-color': nameColor } as CSSVars)
            : undefined
        }
      >
        @{name}
      </span>
      <span className="min-w-0 truncate">{snippet}</span>
    </MessageReply>
  )
}

/** Верхняя «надстройка» композера при ответе — без своего фона и рамки. */
export function ComposerReplyBanner({
  message,
  users,
  mentionEnabled,
  onMentionToggle,
  onClear,
  authorColor,
}: {
  message: Message
  users: Record<string, User>
  mentionEnabled?: boolean
  onMentionToggle?: (enabled: boolean) => void
  onClear: () => void
  authorColor?: string
}) {
  const t = useTranslations('chat')
  const name = messageAuthorName(message, users, t('messageLabel'))
  const showMentionToggle = onMentionToggle != null && mentionEnabled != null

  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-3">
      <p className="min-w-0 truncate text-sm leading-none">
        <span className="text-muted-foreground">{t('replyingTo')} </span>
        <span
          className={cn(
            'font-semibold',
            authorColor ? 'text-(--reply-author-color)' : 'text-primary',
          )}
          style={
            authorColor
              ? ({ '--reply-author-color': authorColor } as CSSVars)
              : undefined
          }
        >
          {name}
        </span>
      </p>

      <div className="flex shrink-0 items-center gap-1">
        {showMentionToggle ? (
          <Toggle
            size="sm"
            pressed={mentionEnabled}
            onPressedChange={onMentionToggle}
            title={mentionEnabled ? t('mentionOn') : t('mentionOff')}
          >
            @ {mentionEnabled ? t('mentionOnShort') : t('mentionOffShort')}
          </Toggle>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onClear}
          aria-label={t('cancelReply')}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  )
}
