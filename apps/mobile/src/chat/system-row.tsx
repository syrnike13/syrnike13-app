import type { Message as ApiMessage, User } from '@syrnike13/api-types'
import { formatMessageTimeShort, messageCreatedAt } from '@syrnike13/client/lib/message-time'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'
import {
  Message,
  MessageContent,
  MessageIcon,
  MessageText,
  MessageTimestamp,
} from '@syrnike13/ui-native/primitives/message'

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CrownIcon,
  InfoIcon,
  PencilIcon,
  PhoneFilledIcon,
  PhoneOffIcon,
  PinIcon,
} from '../components/icons/registry'

type SystemMessage = NonNullable<ApiMessage['system']>
type Translate = (key: string, values?: Record<string, string | number>) => string

function isSuccessfulCall(system: Extract<SystemMessage, { type: 'call_started' }>) {
  return Boolean(system.finished_at) && (system.ended_reason ?? 'completed') === 'completed'
}

function callDuration(startedAt: Date, finishedAt: string, t: Translate) {
  const finished = new Date(finishedAt).getTime()
  if (!Number.isFinite(finished)) return null
  const seconds = Math.max(1, Math.round((finished - startedAt.getTime()) / 1000))
  if (seconds < 60) return t('durationSeconds', { count: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('durationMinutes', { count: minutes })
  return t('durationHours', { count: Math.round(minutes / 60) })
}

/** The same sentences as the web feed, as plain text. */
function systemText(system: SystemMessage, name: (id: string) => string, startedAt: Date, t: Translate) {
  switch (system.type) {
    case 'text':
      return system.content
    case 'user_added':
      return t('userAdded', { actor: name(system.by), target: name(system.id) })
    case 'user_remove':
      return t('userRemoved', { actor: name(system.by), target: name(system.id) })
    case 'user_joined':
      return t('userJoined', { user: name(system.id) })
    case 'user_left':
      return t('userLeft', { user: name(system.id) })
    case 'user_kicked':
      return t('userKicked', { user: name(system.id) })
    case 'user_banned':
      return t('userBanned', { user: name(system.id) })
    case 'channel_renamed':
      return t('channelRenamed', { actor: name(system.by), name: system.name })
    case 'channel_description_changed':
      return t('channelDescriptionChanged', { actor: name(system.by) })
    case 'channel_icon_changed':
      return t('channelIconChanged', { actor: name(system.by) })
    case 'channel_ownership_changed':
      return t('ownershipTransferred', { from: name(system.from), to: name(system.to) })
    case 'message_pinned':
      return t('messagePinned', { actor: name(system.by) })
    case 'message_unpinned':
      return t('messageUnpinned', { actor: name(system.by) })
    case 'call_started': {
      const reason = system.ended_reason ?? 'completed'
      const status = !system.finished_at
        ? t('callOngoing')
        : reason === 'cancelled'
          ? t('callCancelled')
          : reason === 'missed'
            ? t('callMissed')
            : t('callEnded')
      const duration = system.finished_at ? callDuration(startedAt, system.finished_at, t) : null
      return `${name(system.by)} ${t('callStarted')} · ${status}${duration ? ` · ${duration}` : ''}`
    }
  }
}

function SystemIcon({ system }: { system: SystemMessage }) {
  switch (system.type) {
    case 'user_added':
    case 'user_joined':
      return <ArrowRightIcon size={16} className="text-success" />
    case 'user_remove':
    case 'user_left':
    case 'user_kicked':
    case 'user_banned':
      return <ArrowLeftIcon size={16} className="text-destructive" />
    case 'channel_renamed':
    case 'channel_description_changed':
    case 'channel_icon_changed':
      return <PencilIcon size={16} className="text-muted-foreground" />
    case 'channel_ownership_changed':
      return <CrownIcon size={16} className="text-muted-foreground" />
    case 'message_pinned':
    case 'message_unpinned':
      return <PinIcon size={16} className="text-muted-foreground" />
    case 'call_started':
      return isSuccessfulCall(system) ? (
        <PhoneFilledIcon size={16} className="text-success" />
      ) : (
        <PhoneOffIcon size={16} className="text-muted-foreground" />
      )
    case 'text':
      return <InfoIcon size={16} className="text-muted-foreground" />
  }
}

/** Joins, renames, pins and calls: an icon in the avatar column and one muted line. */
export function SystemRow({ message, system }: { message: ApiMessage; system: SystemMessage }) {
  const t = useTranslations('mobile.chat.system')
  const { locale } = useLocale()
  const users = useSyncStore((state) => state.users)
  const name = (id: string) => {
    const user: User | undefined = users[id]
    return user?.display_name ?? user?.username ?? t('user')
  }
  const createdAt = messageCreatedAt(message)

  return (
    <Message groupStart>
      <MessageIcon>
        <SystemIcon system={system} />
      </MessageIcon>
      <MessageContent>
        <MessageText className="text-muted-foreground">
          {systemText(system, name, createdAt, t)}
          <MessageTimestamp>{`  ${formatMessageTimeShort(createdAt, locale)}`}</MessageTimestamp>
        </MessageText>
      </MessageContent>
    </Message>
  )
}
