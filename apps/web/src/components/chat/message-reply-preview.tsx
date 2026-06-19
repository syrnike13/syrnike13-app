import type { Channel, Member, Message, Server, User } from '@syrnike13/api-types'
import { XIcon } from '#/components/icons'

import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import { memberRoleEntries } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

const MESSAGE_ENTITY_RE = /<([@%#])([^>]+)>/g

export function messageAuthorName(message: Message, users: Record<string, User>) {
  if (message.user) {
    return message.user.display_name ?? message.user.username
  }
  const user = users[message.author]
  return user?.display_name ?? user?.username ?? 'Сообщение'
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

function replySnippet(
  content: Message['content'],
  users: Record<string, User>,
  roles: Server['roles'] | undefined,
  channels: Record<string, Channel>,
) {
  const trimmed = content?.trim()
  if (!trimmed) return '[вложение]'

  return trimmed
    .replace(MESSAGE_ENTITY_RE, (match, marker: string, id: string) => {
      if (marker === '@') {
        const user = users[id]
        return `@${user?.display_name ?? user?.username ?? id}`
      }

      if (marker === '%') {
        return `@${roles?.[id]?.name ?? id}`
      }

      if (marker === '#') {
        const channel = channels[id]
        const name = channel && 'name' in channel ? channel.name : undefined
        return `#${name ?? id}`
      }

      return match
    })
    .slice(0, 100)
}

/** Уголок «ответа» — border + скругление. */
function ReplyThreadCorner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mb-0.5 box-border h-3 w-[22px] shrink-0 rounded-tl-[5px]',
        'border-t-2 border-l-2 border-muted-foreground/45',
        className,
      )}
    />
  )
}

/** Цитата ответа в ленте — мини-аватар, имя, превью. */
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
  const members = useSyncStore((s) => s.members)
  const servers = useSyncStore((s) => s.servers)
  const channels = useSyncStore((s) => s.channels)

  const original = messagesById[replyId]
  if (!original) {
    return (
      <p className="mb-1 min-h-4 text-xs leading-4 text-muted-foreground italic">
        Ответ на удалённое сообщение
      </p>
    )
  }

  const name = messageAuthorName(original, users)
  const replyUser = original.user ?? users[original.author]
  const server = serverId ? servers[serverId] : undefined
  const snippet = replySnippet(original.content, users, server?.roles, channels)
  const nameColor = replyAuthorColor(
    serverId,
    original,
    members,
    servers,
  )

  const rowClass = cn(
    'mb-1 flex max-w-full min-w-0 items-end gap-1.5 rounded-sm text-left',
    onJump &&
      'cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  )

  const body = (
    <>
      <ReplyThreadCorner className="-ml-7" />
      {replyUser ? (
        <UserAvatar
          user={replyUser}
          className="mb-px size-4 shrink-0"
          fallbackClassName="size-4 text-[8px]"
          showPresence={false}
        />
      ) : null}
      <span
        className={cn(
          'shrink-0 text-[13px] font-semibold leading-4',
          !nameColor && 'text-primary',
        )}
        style={nameColor ? { color: nameColor } : undefined}
      >
        {name}
      </span>
      <span className="min-w-0 truncate text-[13px] leading-4 text-muted-foreground">
        {snippet}
      </span>
    </>
  )

  if (!onJump) {
    return <div className={rowClass}>{body}</div>
  }

  return (
    <button type="button" className={cn(rowClass, 'w-full')} onClick={() => onJump(replyId)}>
      {body}
    </button>
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
  const name = messageAuthorName(message, users)
  const showMentionToggle = onMentionToggle != null && mentionEnabled != null

  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-3">
      <p className="min-w-0 truncate text-[13px] leading-none">
        <span className="text-muted-foreground">Ответить </span>
        <span
          className={cn('font-semibold', !authorColor && 'text-primary')}
          style={authorColor ? { color: authorColor } : undefined}
        >
          {name}
        </span>
      </p>

      <div className="flex shrink-0 items-center gap-1.5">
        {showMentionToggle ? (
          <button
            type="button"
            className={cn(
              'rounded px-1 text-[11px] font-semibold leading-none transition-colors',
              mentionEnabled
                ? 'text-primary hover:text-primary/80'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => onMentionToggle(!mentionEnabled)}
            title={
              mentionEnabled
                ? 'Упоминание включено'
                : 'Упоминание выключено'
            }
          >
            @ {mentionEnabled ? 'ВКЛ' : 'ВЫКЛ'}
          </button>
        ) : null}

        {showMentionToggle ? (
          <div className="h-3.5 w-px bg-foreground/15" aria-hidden />
        ) : null}

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          onClick={onClear}
          aria-label="Отменить ответ"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
