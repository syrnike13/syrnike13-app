import type { Channel, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import { HashIcon, UsersIcon } from '#/components/icons'
import { UserAvatar } from '#/components/user/user-avatar'
import { getChannelLabel, getDmRecipientId } from '@syrnike13/client/sync/channel-label'
import { attachmentPreviewUrl } from '#/lib/media'

/** Начало истории канала, как в Discord: крупная иконка, заголовок, пояснение. */
export function ChannelIntro({
  channel,
  users,
  currentUserId,
}: {
  channel: Channel
  users: Record<string, User>
  currentUserId?: string
}) {
  const t = useTranslations('chat.intro')
  const tChat = useTranslations('chat')
  const label = getChannelLabel(channel, users, currentUserId, tChat)
  const recipient = users[getDmRecipientId(channel, currentUserId) ?? '']

  let media
  let title = label
  let text: string

  switch (channel.channel_type) {
    case 'DirectMessage':
      media = (
        <UserAvatar
          user={recipient}
          className="size-20"
          fallbackClassName="size-20 text-2xl"
          showPresence={false}
        />
      )
      text = t('dmText', { name: label })
      break
    case 'Group':
      media = channel.icon ? (
        <img
          src={attachmentPreviewUrl(channel.icon)}
          alt=""
          className="size-17 rounded-full object-cover"
        />
      ) : (
        <span className="flex size-17 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <UsersIcon className="size-9" />
        </span>
      )
      title = t('groupTitle', { name: label })
      text = t('groupText', { name: label })
      break
    case 'SavedMessages':
      media = null
      text = t('savedText')
      break
    default:
      media = (
        <span className="flex size-17 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <HashIcon className="size-10" />
        </span>
      )
      title = t('channelTitle', { name: label })
      text = t('channelText', { name: label })
  }

  return (
    <section className="mx-4 mt-4 mb-2 flex flex-col items-start gap-2">
      {media}
      <h2 className="text-3xl leading-10 font-bold text-foreground">{title}</h2>
      {channel.channel_type === 'DirectMessage' && recipient ? (
        <p className="-mt-2 text-xl leading-6 text-foreground">
          {recipient.username}
        </p>
      ) : null}
      <p className="text-base text-muted-foreground">{text}</p>
    </section>
  )
}
