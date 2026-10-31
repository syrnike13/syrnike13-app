import { useMemo, useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'
import { PlusIcon, XIcon } from '#/components/icons'

import { Button } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { ProfileSection } from '#/components/user/profile/profile-parts'
import { EditMemberRolesDialog } from '#/components/servers/edit-member-roles-dialog'
import { useAuth } from '#/features/auth/auth-context'
import { editServerMemberEffect } from '@syrnike13/client/api/servers-api'
import {
  memberRoleEntries,
  type MemberRoleEntry,
} from '@syrnike13/client/sync/selectors'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import {
  canEditAnyMemberRole,
  canToggleMemberRole,
} from '#/lib/member-roles'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

type UserProfileRoleListProps = {
  user: User
  serverId?: string
  roles?: MemberRoleEntry[]
  /** Заголовок секции (модалка, панель). */
  title?: string
  /** Свернуть лишние роли в «+N». */
  maxVisible?: number
  className?: string
}

function roleDotColour(colour: string | null) {
  if (!colour) return 'var(--muted-foreground)'
  return colour.startsWith('#') ? colour : `#${colour}`
}

/**
 * Список ролей: высота 24px, радиус 8px, точка 12px,
 * подпись 12/16, крестик 24×24, «+N» для скрытых ролей.
 */
export function UserProfileRoleList({
  user,
  serverId,
  roles: rolesProp,
  title,
  maxVisible,
  className,
}: UserProfileRoleListProps) {
  const t = useTranslations('users')
  const auth = useAuth()
  const token = auth.session?.token
  const actorUserId = auth.user?._id
  const [expanded, setExpanded] = useState(false)
  const [rolesDialogOpen, setRolesDialogOpen] = useState(false)
  const [removingRoleId, setRemovingRoleId] = useState<string | null>(null)

  const server = useSyncStore((state) =>
    serverId ? state.servers[serverId] : undefined,
  )
  const member = useSyncStore((state) =>
    serverId ? state.members[`${serverId}:${user._id}`] : undefined,
  )
  const actorMember = useSyncStore((state) =>
    serverId && actorUserId
      ? state.members[`${serverId}:${actorUserId}`]
      : undefined,
  )
  const roles = rolesProp ?? (member ? memberRoleEntries(server, member) : [])
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

  if (roles.length === 0 && !canEditRoles) return null

  const visibleRoles =
    maxVisible != null && !expanded ? roles.slice(0, maxVisible) : roles
  const hiddenCount = roles.length - visibleRoles.length

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
    const nextRoles = (member.roles ?? []).filter((id) => id !== roleId)
    await Effect.runPromise(
      editServerMemberEffect(token, server._id, member._id.user, {
        roles: nextRoles,
      }).pipe(
        Effect.tap((updated) =>
          Effect.sync(() => syncStore.upsertMembers([updated])),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
        Effect.ensuring(Effect.sync(() => setRemovingRoleId(null))),
      ),
    )
  }

  const list = (
    <div className={cn('min-w-0', className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {visibleRoles.map((role) => {
          const serverRole = server?.roles?.[role.id]
          let canRemove = false
          if (server && member && actorUserId && serverRole) {
            canRemove = canToggleMemberRole(
              server,
              actorMember,
              actorUserId,
              member,
              serverRole,
              false,
            )
          }
          const removing = removingRoleId === role.id

          return (
            <span
              key={role.id}
              className={cn(
                'inline-flex h-6 max-w-full items-center gap-1.5 rounded-lg bg-secondary text-xs leading-4 font-normal text-secondary-foreground',
                canRemove ? 'pr-0 pl-1.5' : 'px-1.5',
              )}
            >
              <span
                aria-hidden
                className="size-3 shrink-0 rounded-full bg-(--role-dot)"
                style={
                  {
                    '--role-dot': roleDotColour(role.colour),
                  } as CSSVars
                }
              />
              <span className="min-w-0 truncate">{role.name}</span>
              {canRemove ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={removingRoleId !== null}
                  title={t('removeRole', { name: role.name })}
                  aria-label={t('removeRole', { name: role.name })}
                  onClick={(event) => {
                    event.stopPropagation()
                    void removeRole(role.id)
                  }}
                >
                  {removing ? <Spinner className="size-3" /> : <XIcon />}
                </Button>
              ) : (
                <span className="w-0.5" aria-hidden />
              )}
            </span>
          )
        })}

        {hiddenCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={(event) => {
              event.stopPropagation()
              setExpanded(true)
            }}
          >
            +{hiddenCount}
          </Button>
        ) : null}

        {canEditRoles ? (
          <Button
            type="button"
            variant="ghost"
            size={roles.length === 0 ? 'xs' : 'icon-xs'}
            title={t('editRoles')}
            aria-label={t('editRoles')}
            onClick={(event) => {
              event.stopPropagation()
              setRolesDialogOpen(true)
            }}
          >
            <PlusIcon />
            {roles.length === 0 ? t('addRole') : null}
          </Button>
        ) : null}
      </div>

      {canEditRoles && server && member ? (
        <EditMemberRolesDialog
          server={server}
          targetMember={member}
          targetUser={user}
          open={rolesDialogOpen}
          onOpenChange={setRolesDialogOpen}
        />
      ) : null}
    </div>
  )

  return title ? <ProfileSection title={title}>{list}</ProfileSection> : list
}
