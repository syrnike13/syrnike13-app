import { useMemo, useState } from 'react'
import type { Member, Server } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { Switch } from '#/components/ui/switch'
import { useAuth } from '#/features/auth/auth-context'
import { editServerMember } from '#/features/api/servers-api'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  canEditAnyMemberRole,
  canToggleMemberRole,
  listServerRoles,
} from '#/lib/member-roles'
import { roleIconUrl } from '#/lib/media'
import { normalizeRoleColour, roleColourStyle } from '#/lib/server-permissions'
import { cn } from '#/lib/utils'

type MemberRolesEditorProps = {
  server: Server
  targetMember: Member
  className?: string
  showHeading?: boolean
  compact?: boolean
  roleSearch?: string
}

export function MemberRolesEditor({
  server,
  targetMember,
  className,
  showHeading = true,
  compact = false,
  roleSearch = '',
}: MemberRolesEditorProps) {
  const auth = useAuth()
  const actorMember = useSyncStore((state) =>
    auth.user?._id
      ? state.members[`${server._id}:${auth.user._id}`]
      : undefined,
  )
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null)

  const token = auth.session?.token
  const userId = auth.user?._id
  const roles = useMemo(() => listServerRoles(server), [server])
  const assignedRoleIds = useMemo(
    () => new Set(targetMember.roles ?? []),
    [targetMember.roles],
  )
  const editableRoles = useMemo(() => {
    if (!userId) return []
    return roles.filter((role) => {
      const checked = assignedRoleIds.has(role._id)
      return (
        canToggleMemberRole(
          server,
          actorMember,
          userId,
          targetMember,
          role,
          !checked,
        ) ||
        canToggleMemberRole(
          server,
          actorMember,
          userId,
          targetMember,
          role,
          checked,
        )
      )
    })
  }, [actorMember, assignedRoleIds, roles, server, targetMember, userId])

  const filteredRoles = useMemo(() => {
    const query = roleSearch.trim().toLowerCase()
    const source = editableRoles
    if (!query) return source
    return source.filter((role) => role.name.toLowerCase().includes(query))
  }, [editableRoles, roleSearch])

  const canManage = userId
    ? canEditAnyMemberRole(server, actorMember, userId, targetMember)
    : false

  async function toggleRole(roleId: string, enabled: boolean) {
    if (!token || !userId) return

    const role = server.roles?.[roleId]
    if (!role) return
    if (
      !canToggleMemberRole(
        server,
        actorMember,
        userId,
        targetMember,
        role,
        enabled,
      )
    ) {
      return
    }

    const nextRoles = enabled
      ? [...new Set([...(targetMember.roles ?? []), roleId])]
      : (targetMember.roles ?? []).filter((id) => id !== roleId)

    setSavingRoleId(roleId)
    try {
      const updated = await editServerMember(
        token,
        server._id,
        targetMember._id.user,
        { roles: nextRoles },
      )
      syncStore.upsertMembers([updated])
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось обновить роли',
      )
    } finally {
      setSavingRoleId(null)
    }
  }

  if (!canManage) {
    return null
  }

  if (roles.length === 0) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        На сервере пока нет ролей.
      </p>
    )
  }

  if (editableRoles.length === 0) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        Недостаточно прав для изменения ролей этого участника.
      </p>
    )
  }

  return (
    <div className={cn(compact ? 'space-y-0' : 'space-y-2', className)}>
      {showHeading ? (
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Роли
        </p>
      ) : null}
      <ul className={cn(compact ? 'space-y-0' : 'space-y-1')}>
        {filteredRoles.map((role) => {
          const checked = assignedRoleIds.has(role._id)
          const disabled =
            savingRoleId !== null ||
            !canToggleMemberRole(
              server,
              actorMember,
              userId,
              targetMember,
              role,
              !checked,
            )
          const iconUrl = roleIconUrl(role.icon)

          return (
            <li
              key={role._id}
              className={cn(
                'flex items-center justify-between gap-3 rounded-md px-2 hover:bg-muted/40',
                compact ? 'h-9 min-h-9' : 'py-1.5',
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                {iconUrl ? (
                  <img
                    src={iconUrl}
                    alt=""
                    className="size-5 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span
                    className="size-2.5 shrink-0 rounded-full bg-muted-foreground"
                    style={
                      role.colour
                        ? { backgroundColor: normalizeRoleColour(role.colour) }
                        : undefined
                    }
                  />
                )}
                <span
                  className="truncate text-sm font-medium"
                  style={roleColourStyle(role.colour)}
                >
                  {role.name}
                </span>
              </div>
              <Switch
                checked={checked}
                disabled={disabled}
                onCheckedChange={(next) => void toggleRole(role._id, next)}
              />
            </li>
          )
        })}
      </ul>
      {filteredRoles.length === 0 ? (
        <p
          className={cn(
            'px-2 text-center text-sm text-muted-foreground',
            compact ? 'py-4' : 'py-6',
          )}
        >
          {roleSearch.trim() ? 'Роли не найдены.' : 'На сервере пока нет ролей.'}
        </p>
      ) : null}
    </div>
  )
}
