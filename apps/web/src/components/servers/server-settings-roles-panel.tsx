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
import { Effect } from 'effect'
import { toast } from 'sonner'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'

import { FxImage } from '#/components/ui/fx-image'
import { ServerSettingsRoleEditor } from '#/components/servers/server-settings-role-editor'
import { PermissionStateButton } from '#/components/servers/permission-state-button'
import {
  useDraftRegistration,
  type DraftController,
} from '#/components/settings/draft-controller-context'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { useAuth } from '#/features/auth/auth-context'
import {
  createServerRoleEffect,
  deleteServerRoleEffect,
  editServerRoleRanksEffect,
  setDefaultServerPermissionsEffect,
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
  normalizeRoleColour,
  roleRanksPayload,
  SERVER_PERMISSION_GROUPS,
  sortRolesByHierarchy,
  toggleServerPermission,
} from '#/lib/server-permissions'
import { roleIconUrl } from '#/lib/media'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'

const DEFAULT_PERMISSIONS_ID = '__default_permissions__'

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

function formatMemberCount(count: number, t: Translator) {
  return t('memberCount', { count })
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
  const t = useTranslations('servers.roles')
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

  /* eslint-disable shadcn/no-inline-styles */
  // @dnd-kit owns the sortable transform, transition and z-index.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
  }
  /* eslint-enable shadcn/no-inline-styles */

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
          className={cn(
            'block truncate text-sm font-medium',
            role.colour && 'text-(--role-color)',
          )}
          style={
            role.colour
              ? ({
                  '--role-color': normalizeRoleColour(role.colour),
                } as CSSVars)
              : undefined
          }
        >
          {role.name}
        </span>
        <span className="block truncate text-xs font-normal text-muted-foreground">
          <span>{formatMemberCount(memberCount, t)}</span>
        </span>
      </span>
      {!manageable ? (
        <span
          className="shrink-0 text-muted-foreground"
          title={t('viewOnly')}
        >
          <ShieldOffIcon className="size-4" />
        </span>
      ) : null}
      {canDelete ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('roleActions', { name: role.name })}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelect()
                }}
                onPointerDown={(event) => event.stopPropagation()}
              />
            }
          >
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2Icon />
              {t('deleteRole')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
  const t = useTranslations('servers.roles')
  const tp = useTranslations('settings.permissions')
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
    return Effect.runPromise(
      setDefaultServerPermissionsEffect(token, serverId, {
        permissions,
      }).pipe(
        Effect.tap((updated) =>
          Effect.sync(() => syncStore.upsertServer(updated)),
        ),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.sync(() => {
            console.error('[roles] default permissions save failed', error)
            toast.error(t('savePermissionsError'))
            return false
          }),
        ),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    )
  }, [isDirty, permissions, serverId, t, token])

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
        <h3 className="text-base font-semibold">{t('defaultPermissions')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('defaultPermissionsHint')}
        </p>
      </div>

      <div className="space-y-4">
        {SERVER_PERMISSION_GROUPS.map((group) => (
          <section key={group.titleKey} className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground">
              {tp(group.titleKey)}
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
                    <span className="text-sm">{tp(permission.labelKey)}</span>
                    <PermissionStateButton
                      label={tp(permission.labelKey)}
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
  const t = useTranslations('servers.roles')
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
    await Effect.runPromise(
      createServerRoleEffect(token, serverId, {
        name: t('newRole'),
      }).pipe(
        Effect.tap(({ id, role }) =>
          Effect.sync(() => {
            upsertServerRole(serverId, role)
            setSelectedId(id)
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            console.error('[roles] create failed', error)
            toast.error(t('createRoleError'))
          }),
        ),
        Effect.ensuring(Effect.sync(() => setCreating(false))),
      ),
    )
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

    const pendingRole = rolePendingDeletion
    setDeletingRole(true)
    await Effect.runPromise(
      deleteServerRoleEffect(token, serverId, pendingRole._id).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const currentServer = syncStore.getState().servers[serverId]
            if (currentServer?.roles) {
              const {
                [pendingRole._id]: _,
                ...remainingRoles
              } = currentServer.roles
              syncStore.upsertServer({
                ...currentServer,
                roles: remainingRoles,
              })
            }
            setSelectedId((current) =>
              current === pendingRole._id ? DEFAULT_PERMISSIONS_ID : current,
            )
            setRolePendingDeletion(null)
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            console.error('[roles] delete failed', error)
            toast.error(t('deleteRoleError'))
          }),
        ),
        Effect.ensuring(Effect.sync(() => setDeletingRole(false))),
      ),
    )
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
    await Effect.runPromise(
      editServerRoleRanksEffect(token, serverId, {
        ranks: roleRanksPayload(nextOrder),
      }).pipe(
        Effect.tap((updated) =>
          Effect.sync(() => syncStore.upsertServer(updated)),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            console.error('[roles] reorder failed', error)
            toast.error(t('reorderError'))
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            reorderingRequestRef.current = false
            setOptimisticRoleIds(null)
            setReordering(false)
          }),
        ),
      ),
    )
  }

  if (!server || !token || !userId) {
    return null
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden lg:grid lg:h-full lg:min-h-0 settings-shell-grid lg:grid-rows-1 lg:items-stretch">
      <aside className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
        {canCreateRoles ? (
          <Button
            type="button"
            className="h-9 w-full shrink-0"
            disabled={creating || reordering}
            onClick={() => void createRole()}
          >
            <PlusIcon className="size-4" />
            {t('createRole')}
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
              <Empty size="inline">
                <EmptyDescription>{t('noRoles')}</EmptyDescription>
              </Empty>
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
              {t('deleteRoleTitle', {
                name: rolePendingDeletion?.name ?? '',
              })}
            </DialogTitle>
            <DialogDescription>{t('deleteRoleDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deletingRole}
              onClick={() => setRolePendingDeletion(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deletingRole}
              onClick={() => void confirmRoleDeletion()}
            >
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
