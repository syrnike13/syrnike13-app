import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Member, Role, Server } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { FxImage } from '#/components/ui/fx-image'
import { PermissionStateButton } from '#/components/servers/permission-state-button'
import {
  useDraftRegistration,
  type DraftController,
} from '#/components/settings/draft-controller-context'
import { UserAvatar } from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import {
  setChannelRolePermissions,
  setChannelUserPermissions,
  setDefaultChannelPermissions,
} from '#/features/api/channels-api'
import {
  listServerMembers,
  type ServerMemberEntry,
} from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import type { ServerChannel } from '#/lib/channel-voice'
import { canManageRole } from '#/lib/permissions'
import { roleIconUrl } from '#/lib/media'
import {
  getPermissionTriState,
  overrideFieldFromRole,
  overrideFieldToApi,
  roleColourStyle,
  SERVER_PERMISSION_GROUPS,
  setPermissionTriState,
  sortRolesByRankDesc,
  type PermissionOverrideField,
} from '#/lib/server-permissions'
import { cn } from '#/lib/utils'

const DEFAULT_PERMISSIONS_ID = '__default_permissions__'
const USER_PERMISSIONS_PREFIX = '__user_permissions__:'

const ROLE_SIDEBAR_ROW_BASE =
  'flex h-9 w-full items-center gap-2 rounded-md border px-3 text-left text-sm font-medium transition-colors'

function roleSidebarRowStateClass(selected: boolean) {
  return selected
    ? 'border-primary/40 bg-accent text-foreground'
    : 'border-border text-foreground hover:bg-muted/40'
}

function ChannelPermissionEditor({
  channel,
  server,
  member,
  userId,
  token,
  roleId,
  userTargetId,
  roleName,
  initialPermissions,
  canEdit,
}: {
  channel: ServerChannel
  server: Server
  member: Member | undefined
  userId: string
  token: string
  roleId: string | null
  userTargetId?: string
  roleName: string
  initialPermissions: PermissionOverrideField | null | undefined
  canEdit: boolean
}) {
  const [permissions, setPermissions] = useState<PermissionOverrideField>(() =>
    overrideFieldFromRole(initialPermissions),
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setPermissions(overrideFieldFromRole(initialPermissions))
  }, [initialPermissions, roleId, userTargetId])

  const baseline = useMemo(
    () => overrideFieldFromRole(initialPermissions),
    [initialPermissions],
  )

  const isDirty =
    canEdit &&
    (permissions.a !== baseline.a || permissions.d !== baseline.d)

  const resetDraft = useCallback((): boolean => {
    setPermissions(baseline)
    return true
  }, [baseline])

  const save = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true

    setSaving(true)
    try {
      const payload = { permissions: overrideFieldToApi(permissions) }
      const updated = userTargetId
        ? await setChannelUserPermissions(
            token,
            channel._id,
            userTargetId,
            payload,
          )
        : roleId === null
          ? await setDefaultChannelPermissions(token, channel._id, payload)
          : await setChannelRolePermissions(
              token,
              channel._id,
              roleId,
              payload,
            )
      syncStore.patchChannel(channel._id, updated)
      return true
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось сохранить права',
      )
      return false
    } finally {
      setSaving(false)
    }
  }, [channel._id, isDirty, permissions, roleId, token, userTargetId])

  const draftRegistration = useMemo(
    (): DraftController => ({
      isDirty,
      isSaving: saving,
      save,
      reset: resetDraft,
    }),
    [isDirty, resetDraft, save, saving],
  )

  useDraftRegistration(draftRegistration)

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold">Права — {roleName}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Нажмите на переключатель: наследуется → разрешено → запрещено.
        </p>
      </div>

      <div className="space-y-4">
        {SERVER_PERMISSION_GROUPS.map((group) => (
          <section key={group.title} className="space-y-2">
            <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {group.title}
            </h4>
            <ul className="space-y-1">
              {group.permissions.map((permission) => (
                <li
                  key={permission.flag}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40"
                >
                  <span className="text-sm">{permission.label}</span>
                  <PermissionStateButton
                    label={permission.label}
                    state={getPermissionTriState(permissions, permission.flag)}
                    disabled={!canEdit}
                    onChange={(next) =>
                      setPermissions((current) =>
                        setPermissionTriState(current, permission.flag, next),
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {!canEdit ? (
        <p className="text-sm text-muted-foreground">
          Недостаточно прав для изменения прав этой роли.
        </p>
      ) : null}
    </div>
  )
}

function RoleListItem({
  role,
  selected,
  onSelect,
}: {
  role: Role
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        ROLE_SIDEBAR_ROW_BASE,
        roleSidebarRowStateClass(selected),
      )}
      onClick={onSelect}
    >
      {roleIconUrl(role.icon) ? (
        <FxImage
          src={roleIconUrl(role.icon)!}
          rounded="full"
          wrapperClassName="size-5 shrink-0"
          className="size-5"
        />
      ) : null}
      <span className="truncate" style={roleColourStyle(role.colour)}>
        {role.name}
      </span>
    </button>
  )
}

function memberDisplayName({ member, user }: ServerMemberEntry) {
  return member.nickname?.trim() || user.display_name || user.username
}

function MemberListItem({
  entry,
  selected,
  onSelect,
}: {
  entry: ServerMemberEntry
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        ROLE_SIDEBAR_ROW_BASE,
        roleSidebarRowStateClass(selected),
      )}
      onClick={onSelect}
    >
      <UserAvatar
        user={entry.user}
        className="size-5 shrink-0"
        showPresence={false}
      />
      <span className="truncate">{memberDisplayName(entry)}</span>
    </button>
  )
}

export function ChannelSettingsPermissionsPanel({
  channel,
  server,
  member,
}: {
  channel: ServerChannel
  server: Server
  member: Member | undefined
}) {
  const auth = useAuth()
  const roles = useMemo(
    () => (server.roles ? sortRolesByRankDesc(Object.values(server.roles)) : []),
    [server.roles],
  )
  const members = useSyncStore((s) => listServerMembers(s, server._id))
  const [selectedId, setSelectedId] = useState(DEFAULT_PERMISSIONS_ID)

  const token = auth.session?.token
  const userId = auth.user?._id

  const effectiveSelectedId = useMemo(() => {
    if (selectedId === DEFAULT_PERMISSIONS_ID) return DEFAULT_PERMISSIONS_ID
    if (selectedId && roles.some((role) => role._id === selectedId)) {
      return selectedId
    }
    if (selectedId.startsWith(USER_PERMISSIONS_PREFIX)) {
      const selectedUserId = selectedId.slice(USER_PERMISSIONS_PREFIX.length)
      if (members.some((entry) => entry.user._id === selectedUserId)) {
        return selectedId
      }
    }
    return DEFAULT_PERMISSIONS_ID
  }, [members, selectedId, roles])

  const selectedUserId = effectiveSelectedId.startsWith(
    USER_PERMISSIONS_PREFIX,
  )
    ? effectiveSelectedId.slice(USER_PERMISSIONS_PREFIX.length)
    : undefined

  const selectedRole =
    effectiveSelectedId !== DEFAULT_PERMISSIONS_ID
      ? roles.find((role) => role._id === effectiveSelectedId)
      : undefined
  const selectedUserEntry = selectedUserId
    ? members.find((entry) => entry.user._id === selectedUserId)
    : undefined

  const canEditDefault = Boolean(token && userId)

  const canEditSelectedRole =
    selectedRole && token && userId
      ? canManageRole(server, member, userId, selectedRole.rank ?? 0, {
          permissions: true,
        })
      : false
  const canEditSelectedUser = Boolean(token && userId && selectedUserEntry)

  if (!token || !userId) {
    return null
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[220px_minmax(0,1fr)] lg:grid-rows-1 lg:items-stretch">
      <aside className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
        <div className="scrollbar-overlay min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-pb-24 max-lg:max-h-56">
          <div className="space-y-2 pr-2">
            <button
              type="button"
              className={cn(
                ROLE_SIDEBAR_ROW_BASE,
                roleSidebarRowStateClass(
                  effectiveSelectedId === DEFAULT_PERMISSIONS_ID,
                ),
              )}
              onClick={() => setSelectedId(DEFAULT_PERMISSIONS_ID)}
            >
              @everyone
            </button>

            {roles.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">Нет ролей</p>
            ) : (
              <div className="space-y-1">
                {roles.map((role) => (
                  <RoleListItem
                    key={role._id}
                    role={role}
                    selected={effectiveSelectedId === role._id}
                    onSelect={() => setSelectedId(role._id)}
                  />
                ))}
              </div>
            )}

            <div className="space-y-1 pt-3">
              <p className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                РЈС‡Р°СЃС‚РЅРёРєРё
              </p>
              {members.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">
                  РќРµС‚ СѓС‡Р°СЃС‚РЅРёРєРѕРІ
                </p>
              ) : (
                members.map((entry) => {
                  const selectionId = `${USER_PERMISSIONS_PREFIX}${entry.user._id}`
                  return (
                    <MemberListItem
                      key={entry.user._id}
                      entry={entry}
                      selected={effectiveSelectedId === selectionId}
                      onSelect={() => setSelectedId(selectionId)}
                    />
                  )
                })
              )}
            </div>
          </div>
        </div>
      </aside>

      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="scrollbar-overlay min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-pb-24">
          <div className="min-w-0 pr-2">
            {effectiveSelectedId === DEFAULT_PERMISSIONS_ID ? (
              <ChannelPermissionEditor
                key={DEFAULT_PERMISSIONS_ID}
                channel={channel}
                server={server}
                member={member}
                userId={userId}
                token={token}
                roleId={null}
                roleName="@everyone"
                initialPermissions={channel.default_permissions}
                canEdit={canEditDefault}
              />
            ) : selectedRole ? (
              <ChannelPermissionEditor
                key={selectedRole._id}
                channel={channel}
                server={server}
                member={member}
                userId={userId}
                token={token}
                roleId={selectedRole._id}
                roleName={selectedRole.name}
                initialPermissions={
                  channel.role_permissions?.[selectedRole._id]
                }
                canEdit={canEditSelectedRole}
              />
            ) : selectedUserEntry ? (
              <ChannelPermissionEditor
                key={`${USER_PERMISSIONS_PREFIX}${selectedUserEntry.user._id}`}
                channel={channel}
                server={server}
                member={member}
                userId={userId}
                token={token}
                roleId={null}
                userTargetId={selectedUserEntry.user._id}
                roleName={memberDisplayName(selectedUserEntry)}
                initialPermissions={
                  channel.user_permissions?.[selectedUserEntry.user._id]
                }
                canEdit={canEditSelectedUser}
              />
            ) : (
              <ChannelPermissionEditor
                key={DEFAULT_PERMISSIONS_ID}
                channel={channel}
                server={server}
                member={member}
                userId={userId}
                token={token}
                roleId={null}
                roleName="@everyone"
                initialPermissions={channel.default_permissions}
                canEdit={canEditDefault}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
