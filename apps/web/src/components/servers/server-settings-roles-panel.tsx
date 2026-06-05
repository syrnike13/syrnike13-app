import { useEffect, useMemo, useRef, useState } from 'react'
import type { Member, Role, Server } from '@syrnike13/api-types'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { PlusIcon } from 'lucide-react'
import { toast } from 'sonner'

import { ServerSettingsRoleEditor } from '#/components/servers/server-settings-role-editor'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Switch } from '#/components/ui/switch'
import { useAuth } from '#/features/auth/auth-context'
import {
  createServerRole,
  editServerRoleRanks,
  setDefaultServerPermissions,
} from '#/features/api/servers-api'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  canManageRole,
  hasChannelPermission,
  calculateServerPermissions,
  ChannelPermission,
} from '#/lib/permissions'
import {
  roleColourStyle,
  roleRanksPayload,
  SERVER_PERMISSION_GROUPS,
  sortRolesByRankDesc,
  toggleServerPermission,
} from '#/lib/server-permissions'
import { roleIconUrl } from '#/lib/media'
import { cn } from '#/lib/utils'

const DEFAULT_PERMISSIONS_ID = '__default_permissions__'
const NEW_ROLE_NAME = 'Новая роль'

type ServerSettingsRolesPanelProps = {
  serverId: string
}

function upsertServerRole(serverId: string, role: Role) {
  const server = syncStore.getState().servers[serverId]
  if (!server) return
  syncStore.upsertServer({
    ...server,
    roles: {
      ...server.roles,
      [role._id]: role,
    },
  })
}

function SortableRoleListItem({
  role,
  selected,
  canDrag,
  onSelect,
}: {
  role: Role
  selected: boolean
  canDrag: boolean
  onSelect: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: role._id,
    disabled: !canDrag,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="button"
      tabIndex={0}
      className={cn(
        'flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm font-medium',
        selected ? 'border-primary/40 bg-accent' : 'border-border',
        canDrag && 'cursor-grab touch-none active:cursor-grabbing',
        isDragging && 'opacity-80 shadow-md',
      )}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      {...(canDrag ? { ...attributes, ...listeners } : {})}
    >
      {roleIconUrl(role.icon) ? (
        <img
          src={roleIconUrl(role.icon)!}
          alt=""
          className="size-5 shrink-0 rounded-full object-cover"
        />
      ) : null}
      <span className="truncate" style={roleColourStyle(role.colour)}>
        {role.name}
      </span>
    </div>
  )
}

function SortableRolesList({
  roles,
  server,
  member,
  userId,
  selectedId,
  reordering,
  canReorder,
  onSelect,
  onReorder,
}: {
  roles: Role[]
  server: Server
  member: Member | undefined
  userId: string
  selectedId: string | null
  reordering: boolean
  canReorder: boolean
  onSelect: (roleId: string) => void
  onReorder: (reordered: Role[]) => void
}) {
  const didDragRef = useRef(false)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = roles.findIndex((role) => role._id === active.id)
    const newIndex = roles.findIndex((role) => role._id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    didDragRef.current = true
    onReorder(arrayMove(roles, oldIndex, newIndex))
    window.setTimeout(() => {
      didDragRef.current = false
    }, 0)
  }

  function selectRole(roleId: string) {
    if (didDragRef.current) return
    onSelect(roleId)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={roles.map((role) => role._id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-1">
          {roles.map((role) => {
            const roleRank = role.rank ?? 0
            const canDrag =
              canReorder &&
              canManageRole(server, member, userId, roleRank) &&
              !reordering

            return (
              <SortableRoleListItem
                key={role._id}
                role={role}
                selected={selectedId === role._id}
                canDrag={canDrag}
                onSelect={() => selectRole(role._id)}
              />
            )
          })}
        </div>
      </SortableContext>
    </DndContext>
  )
}

function DefaultPermissionsEditor({
  server,
  serverId,
  token,
  canEdit,
}: {
  server: Server
  serverId: string
  token: string
  canEdit: boolean
}) {
  const [permissions, setPermissions] = useState(server.default_permissions)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setPermissions(server.default_permissions)
  }, [server.default_permissions])

  async function save() {
    setSaving(true)
    try {
      const updated = await setDefaultServerPermissions(token, serverId, {
        permissions,
      })
      syncStore.upsertServer(updated)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось сохранить права',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold">Права по умолчанию</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Базовые права для всех участников сервера без ролей.
        </p>
      </div>

      <div className="space-y-4">
        {SERVER_PERMISSION_GROUPS.map((group) => (
          <section key={group.title} className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground">
              {group.title}
            </h4>
            <ul className="space-y-1">
              {group.permissions.map((permission) => {
                const enabled = hasChannelPermission(
                  permissions,
                  permission.flag,
                )
                return (
                  <li
                    key={permission.flag}
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40"
                  >
                    <span className="text-sm">{permission.label}</span>
                    <Switch
                      checked={enabled}
                      disabled={!canEdit}
                      onCheckedChange={(checked) =>
                        setPermissions((current) =>
                          toggleServerPermission(
                            current,
                            permission.flag,
                            checked,
                          ),
                        )
                      }
                    />
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>

      {canEdit ? (
        <Button type="button" disabled={saving} onClick={() => void save()}>
          Сохранить права
        </Button>
      ) : null}
    </div>
  )
}

export function ServerSettingsRolesPanel({
  serverId,
}: ServerSettingsRolesPanelProps) {
  const auth = useAuth()
  const server = useSyncStore((s) => s.servers[serverId])
  const member = useSyncStore((s) =>
    auth.user?._id ? s.members[`${serverId}:${auth.user._id}`] : undefined,
  )

  const roles = useMemo(
    () => (server?.roles ? sortRolesByRankDesc(Object.values(server.roles)) : []),
    [server?.roles],
  )

  const [selectedId, setSelectedId] = useState(DEFAULT_PERMISSIONS_ID)
  const [creating, setCreating] = useState(false)
  const [reordering, setReordering] = useState(false)

  const token = auth.session?.token
  const userId = auth.user?._id

  const canCreateRoles = server && userId
    ? server.owner === userId ||
      hasChannelPermission(
        calculateServerPermissions(server, member, userId),
        ChannelPermission.ManageRole,
      )
    : false

  const canEditDefaultPermissions = server && userId
    ? server.owner === userId ||
      hasChannelPermission(
        calculateServerPermissions(server, member, userId),
        ChannelPermission.ManagePermissions,
      )
    : false

  const canReorderRoles = Boolean(
    server &&
      userId &&
      (server.owner === userId ||
        hasChannelPermission(
          calculateServerPermissions(server, member, userId),
          ChannelPermission.ManageRole,
        )),
  )

  const effectiveSelectedId = useMemo(() => {
    if (selectedId === DEFAULT_PERMISSIONS_ID) return DEFAULT_PERMISSIONS_ID
    if (selectedId && roles.some((role) => role._id === selectedId)) {
      return selectedId
    }
    return DEFAULT_PERMISSIONS_ID
  }, [selectedId, roles])

  const selectedRole =
    effectiveSelectedId !== DEFAULT_PERMISSIONS_ID
      ? roles.find((role) => role._id === effectiveSelectedId)
      : undefined

  async function createRole() {
    if (!token) return

    setCreating(true)
    try {
      const { id, role } = await createServerRole(token, serverId, {
        name: NEW_ROLE_NAME,
      })
      upsertServerRole(serverId, role)
      setSelectedId(id)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать роль',
      )
    } finally {
      setCreating(false)
    }
  }

  async function persistRoleOrder(reordered: Role[]) {
    if (!token || !canReorderRoles) return

    setReordering(true)
    try {
      const updated = await editServerRoleRanks(token, serverId, {
        ranks: roleRanksPayload(reordered.map((role) => role._id)),
      })
      syncStore.upsertServer(updated)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось изменить порядок',
      )
    } finally {
      setReordering(false)
    }
  }

  if (!server || !token || !userId) {
    return null
  }

  return (
    <div className="grid min-h-[28rem] gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          {canCreateRoles ? (
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={creating || reordering}
              onClick={() => void createRole()}
            >
              <PlusIcon className="size-4" />
              Создать роль
            </Button>
          ) : null}
          <button
            type="button"
            className={cn(
              'w-full rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors',
              effectiveSelectedId === DEFAULT_PERMISSIONS_ID
                ? 'border-primary/40 bg-accent'
                : 'border-border hover:bg-muted/40',
            )}
            onClick={() => setSelectedId(DEFAULT_PERMISSIONS_ID)}
          >
            @everyone
          </button>

          {roles.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">Нет ролей</p>
          ) : (
            <SortableRolesList
              roles={roles}
              server={server}
              member={member}
              userId={userId}
              selectedId={effectiveSelectedId}
              reordering={reordering}
              canReorder={canReorderRoles}
              onSelect={setSelectedId}
              onReorder={(reordered) => void persistRoleOrder(reordered)}
            />
          )}
        </div>

        <div className="min-w-0">
          {effectiveSelectedId === DEFAULT_PERMISSIONS_ID || !selectedRole ? (
            <DefaultPermissionsEditor
              server={server}
              serverId={serverId}
              token={token}
              canEdit={canEditDefaultPermissions}
            />
          ) : (
            <ServerSettingsRoleEditor
              key={selectedRole._id}
              server={server}
              serverId={serverId}
              role={selectedRole}
              token={token}
              userId={userId}
              member={member}
              onDeleted={() => setSelectedId(DEFAULT_PERMISSIONS_ID)}
            />
          )}
        </div>
    </div>
  )
}
