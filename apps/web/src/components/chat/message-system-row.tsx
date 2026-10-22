import type { Message, User } from '@syrnike13/api-types'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'
import { PhoneFilledIcon, PhoneOffIcon } from '#/components/icons'
import type { ReactElement } from 'react'

import { UserProfilePopover } from '#/components/user/user-profile-popover'
import {
  memberRoleEntries,
  type MemberRoleEntry,
} from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { messageCreatedAt } from '#/lib/message-time'
import { useMessageTimestamp } from '#/lib/use-message-time'
import { cn } from '#/lib/utils'

const SYSTEM_ROW_CLASS =
  'group/message relative flex w-full items-start gap-4 py-0.5 pr-6 pl-18 hover:bg-hover'

function callParticipantName(
  userId: string,
  users: Record<string, User>,
  fallback: string,
) {
  const user = users[userId]
  return user?.display_name ?? user?.username ?? fallback
}

function formatCallDuration(
  startedAt: Date,
  finishedAt: string,
  t: Translator,
) {
  const finishedAtMs = new Date(finishedAt).getTime()
  if (!Number.isFinite(finishedAtMs)) return null

  const durationSeconds = Math.max(
    1,
    Math.round((finishedAtMs - startedAt.getTime()) / 1000),
  )

  if (durationSeconds < 60) {
    return t('durationSeconds', { count: durationSeconds })
  }

  const durationMinutes = Math.max(1, Math.round(durationSeconds / 60))
  if (durationMinutes < 60) {
    return t('durationMinutes', { count: durationMinutes })
  }

  const durationHours = Math.max(1, Math.round(durationMinutes / 60))
  return t('durationHours', { count: durationHours })
}

function isSuccessfulVoiceCall(
  system: Extract<Message['system'], { type: 'call_started' }>,
) {
  return (
    Boolean(system.finished_at) &&
    (system.ended_reason ?? 'completed') === 'completed'
  )
}

function MessageAuthorProfileTrigger({
  user,
  serverId,
  serverName,
  roles,
  hideMessage,
  children,
}: {
  user: User
  serverId?: string
  serverName?: string
  roles?: MemberRoleEntry[]
  hideMessage?: boolean
  children: ReactElement
}) {
  return (
    <UserProfilePopover
      user={user}
      serverId={serverId}
      serverName={serverName}
      roles={roles}
      side="right"
      align="start"
      hideMessage={hideMessage}
    >
      {children}
    </UserProfilePopover>
  )
}

function VoiceCallSystemCard({
  message,
  users,
  serverId,
  currentUserId,
}: {
  message: Message
  users: Record<string, User>
  serverId?: string
  currentUserId?: string
}) {
  const t = useTranslations('chat.system')
  const formatTimestamp = useMessageTimestamp()
  if (message.system?.type !== 'call_started') return null

  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const callerId = message.system.by
  const callerUser = users[callerId]
  const member = useSyncStore((s) =>
    serverId ? s.members[`${serverId}:${callerId}`] : undefined,
  )
  const callerName = callParticipantName(callerId, users, t('user'))
  const callerRoles =
    server && member ? memberRoleEntries(server, member) : undefined
  const hideCallerMessage = callerUser?._id === currentUserId
  const startedAt = messageCreatedAt(message)
  const timestamp = formatTimestamp(startedAt)
  const duration = message.system.finished_at
    ? formatCallDuration(startedAt, message.system.finished_at, t)
    : null
  const endedReason = message.system.ended_reason ?? 'completed'
  const endedStatus =
    endedReason === 'cancelled'
      ? t('callCancelled')
      : endedReason === 'missed'
        ? t('callMissed')
        : t('callEnded')
  const callInfo = message.system.finished_at
    ? `${t('callStarted')} · ${endedStatus}${duration ? ` · ${duration}` : ''}`
    : `${t('callStarted')} · ${t('callOngoing')}`
  const successfulCall = isSuccessfulVoiceCall(message.system)

  const callerNameButton = callerUser ? (
    <MessageAuthorProfileTrigger
      user={callerUser}
      serverId={serverId}
      serverName={server?.name}
      roles={callerRoles}
      hideMessage={hideCallerMessage}
    >
      <button
        type="button"
        className={cn(
          'max-w-full truncate rounded-sm text-left font-medium tracking-tight',
          'hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        )}
      >
        {callerName}
      </button>
    </MessageAuthorProfileTrigger>
  ) : (
    <span className="truncate font-medium">{callerName}</span>
  )

  return (
    <article
      data-message-id={message._id}
      className={cn(SYSTEM_ROW_CLASS, 'mt-4.25 items-center')}
    >
      <div
        className="absolute left-4 top-0.5 flex size-10 items-center justify-center"
        aria-hidden
      >
        <span
          className={cn(
            'flex size-10 items-center justify-center',
            successfulCall ? 'text-chart-3' : 'text-muted-foreground',
          )}
          aria-label={
            successfulCall ? t('successfulCall') : t('failedCall')
          }
        >
          {successfulCall ? (
            <PhoneFilledIcon className="size-5" />
          ) : (
            <PhoneOffIcon className="size-5" />
          )}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-base leading-5.5">
          <span className="min-w-0">
            {callerNameButton}
            <span className="text-muted-foreground">{` ${callInfo}`}</span>
          </span>
          <time
            className="shrink-0 text-xs font-medium text-muted-foreground"
            dateTime={startedAt.toISOString()}
          >
            {timestamp}
          </time>
        </p>
      </div>
    </article>
  )
}

function systemUserLabel(
  userId: string,
  users: Record<string, User>,
  fallback: string,
) {
  const user = users[userId]
  return user?.display_name ?? user?.username ?? fallback
}

function systemMessageText(
  system: NonNullable<Message['system']>,
  users: Record<string, User>,
  t: Translator,
) {
  const label = (userId: string) => systemUserLabel(userId, users, t('user'))

  switch (system.type) {
    case 'text':
      return system.content
    case 'user_added':
      return t('userAdded', { actor: label(system.by), target: label(system.id) })
    case 'user_remove':
      return t('userRemoved', { actor: label(system.by), target: label(system.id) })
    case 'user_joined':
      return t('userJoined', { user: label(system.id) })
    case 'user_left':
      return t('userLeft', { user: label(system.id) })
    case 'user_kicked':
      return t('userKicked', { user: label(system.id) })
    case 'user_banned':
      return t('userBanned', { user: label(system.id) })
    case 'channel_renamed':
      return t('channelRenamed', { actor: label(system.by), name: system.name })
    case 'channel_description_changed':
      return t('channelDescriptionChanged', { actor: label(system.by) })
    case 'channel_icon_changed':
      return t('channelIconChanged', { actor: label(system.by) })
    case 'channel_ownership_changed':
      return t('ownershipTransferred', {
        from: label(system.from),
        to: label(system.to),
      })
    case 'message_pinned':
      return t('messagePinned', { actor: label(system.by) })
    case 'message_unpinned':
      return t('messageUnpinned', { actor: label(system.by) })
    case 'call_started':
      return ''
  }
}

function StandardSystemMessageRow({
  message,
  users,
}: {
  message: Message
  users: Record<string, User>
}) {
  const t = useTranslations('chat.system')
  const formatTimestamp = useMessageTimestamp()
  if (!message.system || message.system.type === 'call_started') return null

  const createdAt = messageCreatedAt(message)
  const timestamp = formatTimestamp(createdAt)

  return (
    <article
      data-message-id={message._id}
      className={cn(SYSTEM_ROW_CLASS, 'mt-4.25 min-h-10 items-center gap-3')}
    >
      <span
        aria-hidden="true"
        className="absolute left-4 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-muted text-base text-muted-foreground">
          •
        </span>
      </span>
      <p className="min-w-0 text-base leading-5.5 text-muted-foreground">
        <span className="text-foreground">
          {systemMessageText(message.system, users, t)}
        </span>{' '}
        <time className="text-xs font-medium" dateTime={createdAt.toISOString()}>
          {timestamp}
        </time>
      </p>
    </article>
  )
}

export function MessageSystemRow(props: {
  message: Message
  users: Record<string, User>
  serverId?: string
  currentUserId?: string
}) {
  if (props.message.system?.type === 'call_started') {
    return <VoiceCallSystemCard {...props} />
  }
  if (props.message.system) {
    return <StandardSystemMessageRow {...props} />
  }
  return null
}
