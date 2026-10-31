import { Fragment, type ReactNode } from 'react'
import type { Message, User } from '@syrnike13/api-types'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CrownIcon,
  InfoIcon,
  PencilIcon,
  PhoneFilledIcon,
  PhoneOffIcon,
  PinIcon,
} from '#/components/icons'

import { UserProfilePopover } from '#/components/user/user-profile-popover'
import {
  Message as MessagePrimitive,
  MessageContent,
  MessageIcon,
  MessageTimestamp,
} from '@syrnike13/ui/primitives/message'
import { memberRoleEntries } from '@syrnike13/client/sync/selectors'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { messageCreatedAt } from '@syrnike13/client/lib/message-time'
import { useMessageTimestamp } from '#/lib/use-message-time'
import { Button } from '@syrnike13/ui/primitives/button'

type SystemRowProps = {
  message: Message
  users: Record<string, User>
  serverId?: string
  currentUserId?: string
}

type SystemMessage = NonNullable<Message['system']>

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

/** Имя участника в системной строке: открывает профиль, если пользователь известен. */
function SystemUserName({
  userId,
  users,
  serverId,
  currentUserId,
}: {
  userId: string
  users: Record<string, User>
  serverId?: string
  currentUserId?: string
}) {
  const t = useTranslations('chat.system')
  const user = users[userId]
  const server = useSyncStore((s) => (serverId ? s.servers[serverId] : undefined))
  const member = useSyncStore((s) =>
    serverId ? s.members[`${serverId}:${userId}`] : undefined,
  )
  const name = user?.display_name ?? user?.username ?? t('user')

  if (!user) {
    return <span className="font-medium text-foreground">{name}</span>
  }

  return (
    <UserProfilePopover
      user={user}
      serverId={serverId}
      serverName={server?.name}
      roles={server && member ? memberRoleEntries(server, member) : undefined}
      side="right"
      align="start"
      hideMessage={user._id === currentUserId}
    >
      <Button type="button" variant="plain" size="inline" className="text-foreground">
        <span className="font-medium">{name}</span>
      </Button>
    </UserProfilePopover>
  )
}

const MARKER = '\u0000'

/**
 * Подставляет узлы в перевод: значения передаются маркерами, затем строка
 * режется по ним. Так имена становятся кнопками без rich-форматирования.
 */
function renderTemplate(
  translate: (values: Record<string, string>) => string,
  nodes: Record<string, ReactNode>,
) {
  const markers = Object.fromEntries(
    Object.keys(nodes).map((key) => [key, `${MARKER}${key}${MARKER}`]),
  )
  return translate(markers)
    .split(MARKER)
    .map((part, index) =>
      index % 2 === 1 && part in nodes ? (
        <Fragment key={index}>{nodes[part]}</Fragment>
      ) : (
        part
      ),
    )
}

function systemIcon(system: SystemMessage) {
  switch (system.type) {
    case 'user_added':
    case 'user_joined':
      return { tone: 'success' as const, icon: <ArrowRightIcon /> }
    case 'user_remove':
    case 'user_left':
    case 'user_kicked':
    case 'user_banned':
      return { tone: 'destructive' as const, icon: <ArrowLeftIcon /> }
    case 'channel_renamed':
    case 'channel_description_changed':
    case 'channel_icon_changed':
      return { tone: 'default' as const, icon: <PencilIcon /> }
    case 'channel_ownership_changed':
      return { tone: 'default' as const, icon: <CrownIcon /> }
    case 'message_pinned':
    case 'message_unpinned':
      return { tone: 'default' as const, icon: <PinIcon /> }
    case 'call_started':
      return isSuccessfulVoiceCall(system)
        ? { tone: 'success' as const, icon: <PhoneFilledIcon /> }
        : { tone: 'default' as const, icon: <PhoneOffIcon /> }
    case 'text':
      return { tone: 'default' as const, icon: <InfoIcon /> }
  }
}

function systemText(
  system: SystemMessage,
  name: (userId: string) => ReactNode,
  startedAt: Date,
  t: Translator,
): ReactNode {
  switch (system.type) {
    case 'text':
      return system.content
    case 'user_added':
      return renderTemplate((v) => t('userAdded', v), {
        actor: name(system.by),
        target: name(system.id),
      })
    case 'user_remove':
      return renderTemplate((v) => t('userRemoved', v), {
        actor: name(system.by),
        target: name(system.id),
      })
    case 'user_joined':
      return renderTemplate((v) => t('userJoined', v), { user: name(system.id) })
    case 'user_left':
      return renderTemplate((v) => t('userLeft', v), { user: name(system.id) })
    case 'user_kicked':
      return renderTemplate((v) => t('userKicked', v), { user: name(system.id) })
    case 'user_banned':
      return renderTemplate((v) => t('userBanned', v), { user: name(system.id) })
    case 'channel_renamed':
      return renderTemplate(
        (v) => t('channelRenamed', { ...v, name: system.name }),
        { actor: name(system.by) },
      )
    case 'channel_description_changed':
      return renderTemplate((v) => t('channelDescriptionChanged', v), {
        actor: name(system.by),
      })
    case 'channel_icon_changed':
      return renderTemplate((v) => t('channelIconChanged', v), {
        actor: name(system.by),
      })
    case 'channel_ownership_changed':
      return renderTemplate((v) => t('ownershipTransferred', v), {
        from: name(system.from),
        to: name(system.to),
      })
    case 'message_pinned':
      return renderTemplate((v) => t('messagePinned', v), {
        actor: name(system.by),
      })
    case 'message_unpinned':
      return renderTemplate((v) => t('messageUnpinned', v), {
        actor: name(system.by),
      })
    case 'call_started': {
      const endedReason = system.ended_reason ?? 'completed'
      const status = !system.finished_at
        ? t('callOngoing')
        : endedReason === 'cancelled'
          ? t('callCancelled')
          : endedReason === 'missed'
            ? t('callMissed')
            : t('callEnded')
      const duration = system.finished_at
        ? formatCallDuration(startedAt, system.finished_at, t)
        : null
      return (
        <>
          {name(system.by)}
          {` ${t('callStarted')} · ${status}${duration ? ` · ${duration}` : ''}`}
        </>
      )
    }
  }
}

export function MessageSystemRow({
  message,
  users,
  serverId,
  currentUserId,
}: SystemRowProps) {
  const t = useTranslations('chat.system')
  const formatTimestamp = useMessageTimestamp()
  if (!message.system) return null

  const createdAt = messageCreatedAt(message)
  const { tone, icon } = systemIcon(message.system)
  const callLabel =
    message.system.type === 'call_started'
      ? isSuccessfulVoiceCall(message.system)
        ? t('successfulCall')
        : t('failedCall')
      : undefined
  const name = (userId: string) => (
    <SystemUserName
      userId={userId}
      users={users}
      serverId={serverId}
      currentUserId={currentUserId}
    />
  )

  return (
    <MessagePrimitive data-message-id={message._id} groupStart>
      <MessageIcon
        tone={tone}
        role={callLabel ? 'img' : undefined}
        aria-hidden={callLabel ? undefined : true}
        aria-label={callLabel}
      >
        {icon}
      </MessageIcon>
      <MessageContent>
        <p className="text-muted-foreground">
          {systemText(message.system, name, createdAt, t)}
          <MessageTimestamp dateTime={createdAt.toISOString()}>
            {formatTimestamp(createdAt)}
          </MessageTimestamp>
        </p>
      </MessageContent>
    </MessagePrimitive>
  )
}
