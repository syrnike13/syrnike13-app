import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import {
  MoreHorizontalIcon,
  PlusIcon,
  ShieldOffIcon,
  Trash2Icon,
} from '#/components/icons'
import { toast } from 'sonner'

import { FxImage } from '#/components/ui/fx-image'
import { ServerSettingsRoleEditor } from '#/components/servers/server-settings-role-editor'
import { PermissionStateButton } from '#/components/servers/permission-state-button'
import {
  useDraftRegistration,
  type DraftController,
} from '#/components/settings/draft-controller-context'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  FloatingMenu,
  FloatingMenuItem,
} from '#/components/ui/floating-menu'
import { useAuth } from '#/features/auth/auth-context'
import {
  createServerRole,
  deleteServerRole,
  editServerRoleRanks,
  setDefaultServerPermissions,
} from '#/features/api/servers-api'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  canGrantServerPermission,
  canManageRole,
  canManageServerPermissions,
  canManageServerRoles,
} from '#/features/authorization/authorization'
import {
  hasServerPermission,
  roleColourStyle,
  roleRanksPayload,
  SERVER_PERMISSION_GROUPS,
  sortRolesByHierarchy,
  toggleServerPermission,
} from '#/lib/server-permissions'
import { roleIconUrl } from '#/lib/media'
import { cn } from '#/lib/utils'

const DEFAULT_PERMISSIONS_ID = '__default_permissions__'
const NEW_ROLE_NAME = 'Новая роль'

const ROLE_SIDEBAR_ROW_BASE =
  'flex min-h-11 w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors'

function roleSidebarRowStateClass(selected: boolean) {
  return selected
    ? 'border-primary/40 bg-accent text-foreground'
    : 'border-border text-foreground hover:bg-muted/40'
}

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

function formatMemberCount(count: number) {
  const mod10 = count % 10
  const mod100 = count % 100

  if (mod10 === 1 && mod100 !== 11) return `${count} участник`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} участника`
  }
  return `${count} участников`
}

function SortableRoleListItem({
  role,
  selected,
  memberCount,
  manageable,
  canDrag,
  canDelete,
  onSelect,
  onDelete,
}: {
  role: Role
  selected: boolean
  memberCount: number
  manageable: boolean
  canDrag: boolean
  canDelete: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const [menuPosition, setMenuPosition] = useState<{
    x: number
    y: number
  } | null>(null)
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

  const row = (
    <div
      ref={setNodeRef}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={role.name}
      className={cn(
        ROLE_SIDEBAR_ROW_BASE,
        roleSidebarRowStateClass(selected),
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
        <FxImage
          src={roleIconUrl(role.icon)!}
          rounded="full"
          wrapperClassName="size-5 shrink-0"
          className="size-5"
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-sm font-medium"
          style={roleColourStyle(role.colour)}
        >
          {role.name}
        </span>
        <span className="block truncate text-[11px] font-normal text-muted-foreground">
          <span>{formatMemberCount(memberCount)}</span>
        </span>
      </span>
      {!manageable ? (
        <span
          className="shrink-0 text-muted-foreground"
          title="Только просмотр"
        >
          <ShieldOffIcon className="size-4" />
        </span>
      ) : null}
      {canDelete ? (
        <>
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Действия роли ${role.name}`}
            aria-haspopup="menu"
            aria-expanded={menuPosition ? true : undefined}
            onClick={(event) => {
              event.stopPropagation()
              onSelect()
              const rect = event.currentTarget.getBoundingClientRect()
              setMenuPosition({
                x: Math.max(8, rect.right - 192),
                y: rect.bottom + 4,
              })
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <MoreHorizontalIcon className="size-4" />
          </button>
          <FloatingMenu
            open={Boolean(menuPosition)}
            x={menuPosition?.x ?? 0}
            y={menuPosition?.y ?? 0}
            onClose={() => setMenuPosition(null)}
            className="w-48"
          >
            <FloatingMenuItem
              destructive
              onClick={() => {
                setMenuPosition(null)
                onDelete()
              }}
            >
              <Trash2Icon className="size-4" />
              Удалить роль
            </FloatingMenuItem>
          </FloatingMenu>
        </>
      ) : null}
    </div>
  )

  return row
}

function SortableRolesList({
  roles,
  server,
  member,
  userId,
  memberCounts,
  selectedId,
  reordering,
  canReorder,
  onSelect,
  onReorder,
  onDeleteRole,
}: {
  roles: Role[]
  server: Server
  member: Member | undefined
  userId: string
  memberCounts: Record<string, number>
  selectedId: string | null
  reordering: boolean
  canReorder: boolean
  onSelect: (roleId: string) => void
  onReorder: (reordered: Role[]) => void
  onDeleteRole: (role: Role) => void
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

    const activeRole = roles[oldIndex]
    const overRole = roles[newIndex]
    if (
      !canManageRole(server, member, userId, activeRole.rank ?? 0) ||
      !canManageRole(server, member, userId, overRole.rank ?? 0)
    ) {
      return
    }

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
            const manageable = canManageRole(
              server,
              member,
              userId,
              roleRank,
            )
            const canDrag =
              canReorder &&
              manageable &&
              !reordering
            const canDelete = manageable

            return (
              <SortableRoleListItem
                key={role._id}
                role={role}
                selected={selectedId === role._id}
                memberCount={memberCounts[role._id] ?? 0}
                manageable={manageable}
                canDrag={canDrag}
                canDelete={canDelete}
                onSelect={() => selectRole(role._id)}
                onDelete={() => onDeleteRole(role)}
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

  const isDirty = canEdit && permissions !== server.default_permissions

  const resetDraft = useCallback((): boolean => {
    setPermissions(server.default_permissions)
    return true
  }, [server.default_permissions])

  const save = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true

    setSaving(true)
    try {
      const updated = await setDefaultServerPermissions(token, serverId, {
        permissions,
      })
      syncStore.upsertServer(updated)
      return true
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось сохранить права',
      )
      return false
    } finally {
      setSaving(false)
    }
  }, [isDirty, permissions, serverId, token])

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
                const enabled = hasServerPermission(
                  permissions,
                  permission.flag,
                )
                const actorHasPermission = canGrantServerPermission(
                  server,
                  permission.flag,
                )
                return (
                  <li
                    key={permission.flag}
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40"
                  >
                    <span className="text-sm">{permission.label}</span>
                    <PermissionStateButton
                      label={permission.label}
                      state={enabled ? 'allow' : 'neutral'}
                      allowedStates={['neutral', 'allow']}
                      disabled={!canEdit || (!actorHasPermission && !enabled)}
                      onChange={(next) =>
                        setPermissions((current) => {
                          if (next === 'allow' && !actorHasPermission) {
                            return current
                          }
                          return toggleServerPermission(
                            current,
                            permission.flag,
                            next === 'allow',
                          )
                        })
                      }
                    />
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
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
  const roleMemberCounts = useSyncStore((state) => {
    const counts: Record<string, number> = {}
    for (const entry of Object.values(state.members)) {
      if (entry._id.server !== serverId) continue
      for (const roleId of entry.roles ?? []) {
        counts[roleId] = (counts[roleId] ?? 0) + 1
      }
    }
    return counts
  })

  const sortedRoles = useMemo(
    () =>
      server?.roles ? sortRolesByHierarchy(Object.values(server.roles)) : [],
    [server?.roles],
  )

  const [selectedId, setSelectedId] = useState(DEFAULT_PERMISSIONS_ID)
  const [creating, setCreating] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [optimisticRoleIds, setOptimisticRoleIds] = useState<string[] | null>(
    null,
  )
  const reorderingRequestRef = useRef(false)
  const [rolePendingDeletion, setRolePendingDeletion] = useState<Role | null>(
    null,
  )
  const [deletingRole, setDeletingRole] = useState(false)

  const roles = useMemo(() => {
    if (!optimisticRoleIds) return sortedRoles

    const rolesById = new Map(sortedRoles.map((role) => [role._id, role]))
    const optimisticRoles = optimisticRoleIds
      .map((roleId) => rolesById.get(roleId))
      .filter((role): role is Role => Boolean(role))

    if (optimisticRoles.length !== sortedRoles.length) return sortedRoles
    return optimisticRoles
  }, [optimisticRoleIds, sortedRoles])

  const token = auth.session?.token
  const userId = auth.user?._id
  const canCreateRoles = server && userId
    ? canManageServerRoles(server)
    : false

  const canEditDefaultPermissions = server && userId
    ? canManageServerPermissions(server)
    : false

  const canReorderRoles = Boolean(
    server &&
      userId &&
      canManageServerRoles(server),
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

  function requestRoleDeletion(role: Role) {
    if (!token || !userId) return
    if (
      !canManageRole(server, member, userId, role.rank ?? 0)
    ) {
      return
    }

    setRolePendingDeletion(role)
  }

  async function confirmRoleDeletion() {
    if (!token || !userId || !rolePendingDeletion) return
    if (
      !canManageRole(
        server,
        member,
        userId,
        rolePendingDeletion.rank ?? 0,
      )
    ) {
      return
    }

    setDeletingRole(true)
    try {
      await deleteServerRole(token, serverId, rolePendingDeletion._id)
      const currentServer = syncStore.getState().servers[serverId]
      if (currentServer?.roles) {
        const {
          [rolePendingDeletion._id]: _,
          ...remainingRoles
        } = currentServer.roles
        syncStore.upsertServer({ ...currentServer, roles: remainingRoles })
      }
      setSelectedId((current) =>
        current === rolePendingDeletion._id ? DEFAULT_PERMISSIONS_ID : current,
      )
      setRolePendingDeletion(null)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось удалить роль',
      )
    } finally {
      setDeletingRole(false)
    }
  }

  async function persistRoleOrder(reordered: Role[]) {
    if (!token || !canReorderRoles) return

    const nextOrder = reordered.map((role) => role._id)
    const currentOrder = roles.map((role) => role._id)
    if (nextOrder.join('\0') === currentOrder.join('\0')) return
    if (reorderingRequestRef.current) return

    reorderingRequestRef.current = true
    setOptimisticRoleIds(nextOrder)
    setReordering(true)
    try {
      const updated = await editServerRoleRanks(token, serverId, {
        ranks: roleRanksPayload(nextOrder),
      })
      syncStore.upsertServer(updated)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось изменить порядок',
      )
    } finally {
      reorderingRequestRef.current = false
      setOptimisticRoleIds(null)
      setReordering(false)
    }
  }

  if (!server || !token || !userId) {
    return null
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[220px_minmax(0,1fr)] lg:grid-rows-1 lg:items-stretch">
      <aside className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
        {canCreateRoles ? (
          <Button
            type="button"
            className="h-9 w-full shrink-0"
            disabled={creating || reordering}
            onClick={() => void createRole()}
          >
            <PlusIcon className="size-4" />
            Создать роль
          </Button>
        ) : null}

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
              <SortableRolesList
                roles={roles}
                server={server}
                member={member}
                userId={userId}
                memberCounts={roleMemberCounts}
                selectedId={effectiveSelectedId}
                reordering={reordering}
                canReorder={canReorderRoles}
                onSelect={setSelectedId}
                onReorder={(reordered) => void persistRoleOrder(reordered)}
                onDeleteRole={requestRoleDeletion}
              />
            )}
          </div>
        </div>
      </aside>

      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="scrollbar-overlay min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-pb-24">
          <div className="min-w-0 pr-2">
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
                onDeleteRequested={() => requestRoleDeletion(selectedRole)}
              />
            )}
          </div>
        </div>
      </div>
      <Dialog
        open={rolePendingDeletion !== null}
        onOpenChange={(open) => {
          if (!open && !deletingRole) {
            setRolePendingDeletion(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Удалить роль «{rolePendingDeletion?.name}»?
            </DialogTitle>
            <DialogDescription>
              Участники потеряют эту роль. Это действие необратимо.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deletingRole}
              onClick={() => setRolePendingDeletion(null)}
            >
              Отмена
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deletingRole}
              onClick={() => void confirmRoleDeletion()}
            >
              Удалить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
