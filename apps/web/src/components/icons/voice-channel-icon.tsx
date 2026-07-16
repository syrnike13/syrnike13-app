import type { Channel, Server } from '@syrnike13/api-types'

import { Volume2BoldIcon } from '#/components/icons'
import { RestrictedVoiceChannelIcon } from '#/components/icons/restricted-voice-channel-icon'
import { isServerVoiceChannel } from '#/lib/channel-voice'
import { isChannelAccessRestricted } from '#/features/authorization/permission-draft'
import { cn } from '#/lib/utils'

type VoiceChannelIconProps = {
  channel: Channel
  server?: Server
  className?: string
}

function isVoiceChannelRestricted(channel: Channel, server?: Server) {
  return (
    channel.channel_type === 'TextChannel' &&
    isServerVoiceChannel(channel) &&
    server != null &&
    isChannelAccessRestricted(server, channel)
  )
}

/** Иконка серверного голосового канала: динамик или динамик с замком. */
export function VoiceChannelIcon({
  channel,
  server,
  className,
}: VoiceChannelIconProps) {
  const iconClassName = cn(
    'size-4 shrink-0 text-muted-foreground',
    className,
  )

  if (isVoiceChannelRestricted(channel, server)) {
    return <RestrictedVoiceChannelIcon className={iconClassName} />
  }

  return <Volume2BoldIcon className={iconClassName} />
}
