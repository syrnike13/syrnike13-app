import { useQuery } from '@tanstack/react-query'
import { PlusIcon, XIcon } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { EditMemberRolesDialog } from '#/components/servers/edit-member-roles-dialog'
import { UserAvatar } from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import { editServerMember } from '#/features/api/servers-api'
import { fetchUserProfile } from '#/features/api/users-api'
import { syncStore } from '#/features/sync/sync-store'
import {
  canEditAnyMemberRole,
  canToggleMemberRole,
} from '#/lib/member-roles'
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
import { FxImage } from '#/components/ui/fx-image'
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
  const [rolesDialogOpen, setRolesDialogOpen] = useState(false)
  const [removingRoleId, setRemovingRoleId] = useState<string | null>(null)
  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const member = useSyncStore((s) =>
    serverId ? s.members[`${serverId}:${user._id}`] : undefined,
  )
  const actorMember = useSyncStore((s) =>
    serverId && auth.user?._id
      ? s.members[`${serverId}:${auth.user._id}`]
      : undefined,
  )
  const roles =
    rolesProp ?? (member ? memberRoleEntries(server, member) : [])
  const serverName = serverNameProp ?? server?.name
  const token = auth.session?.token
  const actorUserId = auth.user?._id
  const canEditRoles = useMemo(
    () =>
      Boolean(
        server &&
          member &&
          actorUserId &&
          canEditAnyMemberRole(server, actorMember, actorUserId, member),
      ),
    [actorMember, actorUserId, member, server],
  )
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

  async function removeRole(roleId: string) {
    if (!token || !actorUserId || !server || !member) return

    const role = server.roles?.[roleId]
    if (!role) return
    if (
      !canToggleMemberRole(
        server,
        actorMember,
        actorUserId,
        member,
        role,
        false,
      )
    ) {
      return
    }

    setRemovingRoleId(roleId)
    try {
      const nextRoles = (member.roles ?? []).filter((id) => id !== roleId)
      const updated = await editServerMember(
        token,
        server._id,
        member._id.user,
        { roles: nextRoles },
      )
      syncStore.upsertMembers([updated])
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось убрать роль',
      )
    } finally {
      setRemovingRoleId(null)
    }
  }

  return (
    <div className={cn('overflow-hidden', className)}>
      <div className="relative">
        <div
          className={cn(
            'relative w-full overflow-hidden rounded-t-md',
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
              <FxImage
                src={bannerUrl}
                wrapperClassName="block h-full w-full"
                className="h-full w-full"
              />
              <div
                className="pointer-events-none absolute inset-0 z-[1] bg-background/30"
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
            'absolute z-10',
            compact ? 'left-3 -bottom-5' : 'left-4 -bottom-7',
          )}
        >
          <UserAvatar
            user={user}
            className={compact ? 'size-14' : 'size-20'}
            fallbackClassName={cn(
              compact ? 'size-14 text-base ring-4' : 'size-20 text-xl ring-[6px]',
              'ring-muted bg-muted',
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

      {server && member && (roles.length > 0 || canEditRoles) ? (
        <div className="px-4 pb-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Роли
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {roles.map((role) => {
              const serverRole = server.roles?.[role.id]
              const canRemove =
                Boolean(serverRole) &&
                Boolean(actorUserId) &&
                canToggleMemberRole(
                  server,
                  actorMember,
                  actorUserId,
                  member,
                  serverRole!,
                  false,
                )
              const removing = removingRoleId === role.id

              return (
                <span
                  key={role.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-md bg-secondary py-0.5 pr-0.5 pl-2 text-xs font-medium text-secondary-foreground"
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={roleDotStyle(role.colour)}
                  />
                  <span className="truncate">{role.name}</span>
                  {canRemove ? (
                    <button
                      type="button"
                      disabled={removingRoleId !== null}
                      className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                      title={`Убрать роль «${role.name}»`}
                      aria-label={`Убрать роль «${role.name}»`}
                      onClick={(event) => {
                        event.stopPropagation()
                        void removeRole(role.id)
                      }}
                    >
                      <XIcon
                        className={cn('size-3', removing && 'opacity-50')}
                        strokeWidth={2.5}
                      />
                    </button>
                  ) : null}
                </span>
              )
            })}
            {canEditRoles ? (
              <button
                type="button"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="Изменить роли"
                aria-label="Изменить роли"
                onClick={(event) => {
                  event.stopPropagation()
                  setRolesDialogOpen(true)
                }}
              >
                <PlusIcon className="size-3.5" strokeWidth={2.5} />
              </button>
            ) : null}
          </div>
          {canEditRoles ? (
            <EditMemberRolesDialog
              server={server}
              targetMember={member}
              targetUser={user}
              open={rolesDialogOpen}
              onOpenChange={setRolesDialogOpen}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
