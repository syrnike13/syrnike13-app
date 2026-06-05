import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Member, Role, Server } from '@syrnike13/api-types'
import { MoreHorizontalIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { RoleColourPicker } from '#/components/servers/role-colour-picker'
import { RoleColourPreview } from '#/components/servers/role-colour-preview'
import { RoleMembersPanel } from '#/components/servers/role-members-panel'
import { FxImage } from '#/components/ui/fx-image'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Switch } from '#/components/ui/switch'
import { useSyncStore } from '#/features/sync/sync-store'
import { uploadAttachment } from '#/features/api/media-api'
import {
  deleteServerRole,
  editServerRole,
  setServerRolePermissions,
} from '#/features/api/servers-api'
import { syncStore } from '#/features/sync/sync-store'
import { roleIconUrl } from '#/lib/media'
import { canManageRole } from '#/lib/permissions'
import {
  getPermissionTriState,
  overrideFieldFromRole,
  overrideFieldToApi,
  SERVER_PERMISSION_GROUPS,
  setPermissionTriState,
  type PermissionOverrideField,
} from '#/lib/server-permissions'
import { cn } from '#/lib/utils'

import { PermissionStateButton } from '#/components/servers/permission-state-button'
import {
  useDraftRegistration,
  type DraftController,
} from '#/components/settings/draft-controller-context'

type RoleEditorTab = 'display' | 'permissions' | 'members'

function normalizeRoleColour(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed || null
}

function roleEditorTabClass(active: boolean) {
  return cn(
    'relative shrink-0 pb-3 text-sm font-medium transition-colors',
    active
      ? 'text-primary'
      : 'text-muted-foreground hover:text-foreground',
  )
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

export function ServerSettingsRoleEditor({
  server,
  serverId,
  role,
  token,
  userId,
  member,
  onDeleted,
}: {
  server: Server
  serverId: string
  role: Role
  token: string
  userId: string
  member: Member | undefined
  onDeleted: () => void
}) {
  const canEditRole = canManageRole(
    server,
    member,
    userId,
    role.rank ?? 0,
  )
  const canEditPermissions = canManageRole(
    server,
    member,
    userId,
    role.rank ?? 0,
    { permissions: true },
  )
  const [activeTab, setActiveTab] = useState<RoleEditorTab>('display')
  const [name, setName] = useState(role.name)
  const [colour, setColour] = useState(role.colour ?? '')
  const [hoist, setHoist] = useState(Boolean(role.hoist))
  const [mentionable, setMentionable] = useState(role.mentionable !== false)
  const [permissions, setPermissions] = useState<PermissionOverrideField>(() =>
    overrideFieldFromRole(role.permissions),
  )
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [removeIcon, setRemoveIcon] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const memberCount = useSyncStore((state) =>
    Object.values(state.members).filter(
      (entry) =>
        entry._id.server === server._id &&
        (entry.roles ?? []).includes(role._id),
    ).length,
  )

  const roleEditorTabs = useMemo(
    (): { id: RoleEditorTab; label: string }[] => [
      { id: 'display', label: 'Отображение' },
      { id: 'permissions', label: 'Права' },
      {
        id: 'members',
        label: `Управление участниками (${memberCount})`,
      },
    ],
    [memberCount],
  )

  const headerRoleName = (name.trim() || role.name).toUpperCase()

  const previewIconUrl = iconFile
    ? URL.createObjectURL(iconFile)
    : removeIcon
      ? null
      : roleIconUrl(role.icon)

  useEffect(() => {
    setName(role.name)
    setColour(role.colour ?? '')
    setHoist(Boolean(role.hoist))
    setMentionable(role.mentionable !== false)
    setPermissions(overrideFieldFromRole(role.permissions))
    setIconFile(null)
    setRemoveIcon(false)
    setActiveTab('display')
  }, [role])

  useEffect(() => {
    if (!iconFile) return
    const url = URL.createObjectURL(iconFile)
    return () => URL.revokeObjectURL(url)
  }, [iconFile])

  const isRoleMetaDirty = useMemo(() => {
    if (!canEditRole) return false
    const trimmedName = name.trim()
    return (
      trimmedName !== role.name ||
      normalizeRoleColour(colour) !== normalizeRoleColour(role.colour) ||
      hoist !== Boolean(role.hoist) ||
      mentionable !== (role.mentionable !== false) ||
      Boolean(iconFile) ||
      removeIcon
    )
  }, [
    canEditRole,
    colour,
    hoist,
    iconFile,
    mentionable,
    name,
    removeIcon,
    role,
  ])

  const isPermissionsDirty = useMemo(() => {
    if (!canEditPermissions) return false
    const currentPermissions = overrideFieldFromRole(role.permissions)
    return (
      permissions.a !== currentPermissions.a ||
      permissions.d !== currentPermissions.d
    )
  }, [canEditPermissions, permissions, role.permissions])

  const isDirty = isRoleMetaDirty || isPermissionsDirty

  const resetDraft = useCallback((): boolean => {
    setName(role.name)
    setColour(role.colour ?? '')
    setHoist(Boolean(role.hoist))
    setMentionable(role.mentionable !== false)
    setPermissions(overrideFieldFromRole(role.permissions))
    setIconFile(null)
    setRemoveIcon(false)
    return true
  }, [role])

  const save = useCallback(async (): Promise<boolean> => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      toast.error('Укажите название роли')
      return false
    }

    setSaving(true)
    try {
      const colourChanged =
        normalizeRoleColour(colour) !== normalizeRoleColour(role.colour)
      const nameChanged = trimmedName !== role.name
      const hoistChanged = hoist !== Boolean(role.hoist)
      const mentionableChanged =
        mentionable !== (role.mentionable !== false)
      const iconChanged = Boolean(iconFile) || removeIcon

      if (
        canEditRole &&
        (nameChanged ||
          colourChanged ||
          hoistChanged ||
          mentionableChanged ||
          iconChanged)
      ) {
        let iconAttachmentId: string | undefined
        if (iconFile) {
          iconAttachmentId = await uploadAttachment(token, iconFile)
        }

        const updatedRole = await editServerRole(token, serverId, role._id, {
          ...(nameChanged ? { name: trimmedName } : {}),
          ...(colourChanged ? { colour: colour.trim() || null } : {}),
          ...(hoistChanged ? { hoist } : {}),
          ...(mentionableChanged ? { mentionable } : {}),
          ...(iconAttachmentId ? { icon: iconAttachmentId } : {}),
          ...((colourChanged && !colour.trim()) || removeIcon
            ? {
                remove: [
                  ...(colourChanged && !colour.trim()
                    ? (['Colour'] as const)
                    : []),
                  ...(removeIcon ? (['Icon'] as const) : []),
                ],
              }
            : {}),
        })
        upsertServerRole(serverId, updatedRole)
        setIconFile(null)
        setRemoveIcon(false)
      }

      const currentPermissions = overrideFieldFromRole(role.permissions)
      const permissionsChanged =
        permissions.a !== currentPermissions.a ||
        permissions.d !== currentPermissions.d

      if (permissionsChanged && canEditPermissions) {
        const serverAfterPermissions = await setServerRolePermissions(
          token,
          serverId,
          role._id,
          { permissions: overrideFieldToApi(permissions) },
        )
        syncStore.upsertServer(serverAfterPermissions)
      }

      return true
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось сохранить роль',
      )
      return false
    } finally {
      setSaving(false)
    }
  }, [
    colour,
    hoist,
    iconFile,
    mentionable,
    name,
    permissions,
    removeIcon,
    role,
    serverId,
    token,
    canEditRole,
    canEditPermissions,
  ])

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

  async function remove() {
    if (
      !window.confirm(`Удалить роль «${role.name}»? Это действие необратимо.`)
    ) {
      return
    }

    setDeleting(true)
    try {
      await deleteServerRole(token, serverId, role._id)
      const currentServer = syncStore.getState().servers[serverId]
      if (currentServer?.roles) {
        const { [role._id]: _, ...roles } = currentServer.roles
        syncStore.upsertServer({ ...currentServer, roles })
      }
      onDeleted()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось удалить роль',
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-0">
        <div className="flex items-center justify-between gap-4">
          <h2 className="min-w-0 truncate text-xs font-bold tracking-wide uppercase">
            Редактирование роли — {headerRoleName}
          </h2>
          {canEditRole ? (
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                  title="Действия с ролью"
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-1" align="end">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-9 w-full justify-start px-2 font-normal text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={deleting}
                  onClick={() => {
                    setMenuOpen(false)
                    void remove()
                  }}
                >
                  <Trash2Icon className="size-4" />
                  Удалить роль
                </Button>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>

        <nav
          className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-b border-border"
          aria-label="Разделы редактирования роли"
        >
          {roleEditorTabs.map((tab) => {
            const active = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                className={roleEditorTabClass(active)}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
                {active ? (
                  <span
                    className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary"
                    aria-hidden
                  />
                ) : null}
              </button>
            )
          })}
        </nav>
      </div>

      {activeTab === 'display' ? (
        <div className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="role-name">
              Название
              <span className="text-destructive" aria-hidden>
                {' '}
                *
              </span>
              <span className="sr-only"> (обязательно)</span>
            </Label>
            <Input
              id="role-name"
              value={name}
              maxLength={32}
              required
              aria-required="true"
              disabled={!canEditRole}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <RoleColourPicker
            value={colour}
            disabled={!canEditRole}
            onChange={setColour}
          />

          <div className="space-y-3 rounded-md border border-border px-3 py-3">
            <div>
              <p className="text-sm font-medium">Иконка роли</p>
              <p className="text-xs text-muted-foreground">
                Рекомендуется квадратное изображение.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {previewIconUrl ? (
                <FxImage
                  src={previewIconUrl}
                  rounded="full"
                  wrapperClassName="size-12 shrink-0"
                  className="size-12"
                />
              ) : (
                <div className="flex size-12 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                  Нет
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!canEditRole || saving}
                  asChild
                >
                  <label className="cursor-pointer">
                    Загрузить
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      disabled={!canEditRole || saving}
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        if (!file) return
                        setIconFile(file)
                        setRemoveIcon(false)
                        event.target.value = ''
                      }}
                    />
                  </label>
                </Button>
                {previewIconUrl ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!canEditRole || saving}
                    onClick={() => {
                      setIconFile(null)
                      setRemoveIcon(true)
                    }}
                  >
                    Удалить
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          <RoleColourPreview
            name={name}
            colour={colour}
            iconUrl={previewIconUrl}
          />

          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">
                  Отображать роль отдельно от участников
                </p>
                <p className="text-xs text-muted-foreground">
                  Участники с этой ролью будут в отдельной группе в списке.
                </p>
              </div>
              <Switch
                checked={hoist}
                disabled={!canEditRole}
                onCheckedChange={setHoist}
              />
            </div>

            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">
                  Позволять любому пинговать «@» эту роль
                </p>
                <p className="text-xs text-muted-foreground">
                  Если выключено, упоминать роль смогут только участники с правом
                  «Упоминать роли».
                </p>
              </div>
              <Switch
                checked={mentionable}
                disabled={!canEditRole}
                onCheckedChange={setMentionable}
              />
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === 'permissions' ? (
        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">
              Нажмите на переключатель: наследуется → разрешено → запрещено.
            </p>
          </div>

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
                      state={getPermissionTriState(
                        permissions,
                        permission.flag,
                      )}
                      disabled={!canEditPermissions}
                      onChange={(next) =>
                        setPermissions((current) =>
                          setPermissionTriState(
                            current,
                            permission.flag,
                            next,
                          ),
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}

      {activeTab === 'members' ? (
        <RoleMembersPanel server={server} role={role} />
      ) : null}

      {!canEditRole && !canEditPermissions ? (
        <p className="text-sm text-muted-foreground">
          Недостаточно прав для изменения этой роли.
        </p>
      ) : null}
    </div>
  )
}
