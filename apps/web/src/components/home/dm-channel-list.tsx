import { Link } from '@tanstack/react-router'
import { HashIcon } from '#/components/icons'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { UserAvatar } from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import { getChannelLabel, getDmRecipientId } from '#/features/sync/channel-label'
import {
  isChannelUnread,
  listDmChannels,
} from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

type DmChannelListProps = {
  activeChannelId?: string
  className?: string
}

export function DmChannelList({ activeChannelId, className }: DmChannelListProps) {
  const auth = useAuth()
  const ready = useSyncStore((s) => s.ready)
  const users = useSyncStore((s) => s.users)
  const unreads = useSyncStore((s) => s.unreads)
  const dmChannels = useSyncStore((s) =>
    listDmChannels(s, auth.user?._id),
  )

  if (!ready) {
    return (
      <p className={cn('px-2 py-2 text-xs text-muted-foreground', className)}>
        Синхронизация…
      </p>
    )
  }

  if (dmChannels.length === 0) {
    return (
      <p className={cn('px-2 py-2 text-xs text-muted-foreground', className)}>
        Нет личных сообщений
      </p>
    )
  }

  return (
    <nav className={cn('flex flex-col gap-0.5', className)}>
      {dmChannels.map((channel) => {
        const label = getChannelLabel(channel, users, auth.user?._id)
        const active = channel._id === activeChannelId
        const unread =
          !active && isChannelUnread(channel, unreads[channel._id])
        const dmRecipientId = getDmRecipientId(channel, auth.user?._id)
        const dmUser = dmRecipientId ? users[dmRecipientId] : undefined

        return (
          <Button
            key={channel._id}
            variant={active ? 'secondary' : 'ghost'}
            className="h-9 justify-start gap-2 px-2 font-normal"
            asChild
          >
            <Link
              to="/app/c/$channelId"
              params={{ channelId: channel._id }}
            >
              {dmUser ? (
                <UserAvatar
                  user={dmUser}
                  className="size-6"
                  fallbackClassName="size-6 text-[10px]"
                />
              ) : (
                <HashIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {unread ? (
                <Badge className="size-2 shrink-0 rounded-full p-0" />
              ) : null}
            </Link>
          </Button>
        )
      })}
    </nav>
  )
}
