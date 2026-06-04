import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { User } from '@syrnike13/api-types'

import { UserAvatar } from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import { fetchUserProfile } from '#/features/api/users-api'
import { queryKeys } from '#/lib/api/query-keys'
import { userBannerUrl } from '#/lib/media'
import {
  getUserPresence,
  presenceModeLabel,
  userStatusSubtitle,
} from '#/lib/presence'
import {
  memberRoleEntries,
  type MemberRoleEntry,
} from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

function roleDotStyle(colour: string | null) {
  if (!colour) return { backgroundColor: 'var(--muted-foreground)' }
  return { backgroundColor: colour.startsWith('#') ? colour : `#${colour}` }
}

export type UserProfileCardHeaderProps = {
  user: User
  serverId?: string
  serverName?: string
  roles?: MemberRoleEntry[]
  /** Кнопки в правом верхнем углу баннера */
  bannerActions?: ReactNode
  /** Узкая карточка (поповер панели пользователя) */
  compact?: boolean
  className?: string
}

export function UserProfileCardHeader({
  user,
  serverId,
  serverName: serverNameProp,
  roles: rolesProp,
  bannerActions,
  compact = false,
  className,
}: UserProfileCardHeaderProps) {
  const auth = useAuth()
  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const member = useSyncStore((s) =>
    serverId ? s.members[`${serverId}:${user._id}`] : undefined,
  )
  const roles =
    rolesProp ?? (member ? memberRoleEntries(server, member) : [])
  const serverName = serverNameProp ?? server?.name
  const token = auth.session?.token
  const displayName = user.display_name ?? user.username
  const customStatus = user.status?.text?.trim()
  const presenceLabel = presenceModeLabel(getUserPresence(user))

  const profileQuery = useQuery({
    queryKey: queryKeys.users.profile(user._id),
    queryFn: () => fetchUserProfile(token!, user._id),
    enabled: Boolean(token),
    staleTime: 60_000,
  })

  const bannerUrl = userBannerUrl(profileQuery.data?.background)
  const profileBio = profileQuery.data?.content?.trim()

  return (
    <div className={className}>
      <div className="relative">
        <div
          className={cn(
            'relative w-full overflow-hidden',
            bannerUrl
              ? compact
                ? 'h-[72px]'
                : 'h-[120px]'
              : compact
                ? 'h-[56px]'
                : 'h-[88px]',
            !bannerUrl &&
              'bg-gradient-to-br from-primary via-chart-4 to-sidebar-primary',
          )}
        >
          {bannerUrl ? (
            <>
              <img
                src={bannerUrl}
                alt=""
                className="size-full object-cover"
              />
              <div
                className="absolute inset-0 bg-background/30"
                aria-hidden
              />
            </>
          ) : null}
        </div>
        {bannerActions ? (
          <div className="absolute top-2 right-2">{bannerActions}</div>
        ) : null}
        <div
          className={cn(
            'absolute',
            compact ? 'left-3 -bottom-6' : 'left-4 -bottom-8',
          )}
        >
          <UserAvatar
            user={user}
            className={compact ? 'size-14' : 'size-20'}
            fallbackClassName={cn(
              compact ? 'size-14 text-base ring-4' : 'size-20 text-xl ring-[6px]',
              'ring-muted',
            )}
            showPresence
            presenceRingClassName="border-muted"
            presenceClassName={
              compact
                ? 'size-5 translate-x-[16%] translate-y-[16%] border-[3px]'
                : 'size-7 translate-x-[16%] translate-y-[16%] border-4'
            }
          />
        </div>
      </div>

      <div className={cn(compact ? 'px-3 pt-9 pb-2.5' : 'px-4 pt-10 pb-3')}>
        <h2
          className={cn(
            'truncate font-bold leading-tight text-foreground',
            compact ? 'text-xl' : 'text-2xl',
          )}
        >
          {displayName}
        </h2>
        <p
          className={cn(
            'truncate text-muted-foreground',
            compact ? 'text-base' : 'text-sm',
          )}
        >
          {user.display_name ? `@${user.username}` : user.username}
          {customStatus ? (
            <>
              <span className="text-muted-foreground/60"> · </span>
              <span>{customStatus}</span>
            </>
          ) : null}
        </p>
        <p
          className={cn(
            'mt-0.5 truncate text-muted-foreground',
            compact
              ? customStatus
                ? 'text-sm text-muted-foreground/80'
                : 'text-base'
              : customStatus
                ? 'text-xs text-muted-foreground/80'
                : 'text-sm',
          )}
        >
          {customStatus ? presenceLabel : userStatusSubtitle(user)}
        </p>
        {profileBio ? (
          <p
            className={cn(
              'mt-2 line-clamp-3 text-muted-foreground',
              compact ? 'text-base' : 'text-sm',
            )}
          >
            {profileBio}
          </p>
        ) : null}
        {serverName ? (
          <p className="mt-1 text-xs text-muted-foreground/80">
            Участник · {serverName}
          </p>
        ) : null}
      </div>

      {roles.length > 0 ? (
        <div className="px-4 pb-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Роли
          </p>
          <div className="flex flex-wrap gap-1.5">
            {roles.map((role) => (
              <span
                key={role.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={roleDotStyle(role.colour)}
                />
                <span className="truncate">{role.name}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
