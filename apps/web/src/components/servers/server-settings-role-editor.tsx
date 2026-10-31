import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  FieldsRole,
  Member,
  Role,
  Server,
} from '@syrnike13/api-types'
import { MoreHorizontalIcon, Trash2Icon } from '#/components/icons'
import { Effect } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import { RoleColourPicker } from '#/components/servers/role-colour-picker'
import { RoleColourPreview } from '#/components/servers/role-colour-preview'
import { RoleMembersPanel } from '#/components/servers/role-members-panel'
import { FxImage } from '#/components/ui/fx-image'
import { useImageCropper } from '#/components/media/image-crop-dialog'
import { Button } from '@syrnike13/ui/primitives/button'
import { Tabs, TabsList, TabsTrigger } from '@syrnike13/ui/primitives/tabs'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { SettingsToggleRow } from '#/components/settings/settings-panels'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { uploadMediaFileEffect } from '@syrnike13/client/api/media-api'
import {
  editServerRoleEffect,
  setServerRolePermissionsEffect,
} from '@syrnike13/client/api/servers-api'
import { syncStore } from '@syrnike13/client/sync/sync-store'
import { roleIconUrl } from '#/lib/media'
import {
  canGrantServerPermission,
  canManageRole,
} from '#/features/authorization/authorization'
import {
  ADMINISTRATOR_PERMISSION,
  hasServerPermission,
  rolePermissions,
  SERVER_PERMISSION_GROUPS,
  toggleServerPermission,
} from '#/lib/server-permissions'

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
  onDeleteRequested,
}: {
  server: Server
  serverId: string
  role: Role
  token: string
  userId: string
  member: Member | undefined
  onDeleteRequested: () => void
}) {
  const t = useTranslations('servers.roles')
  const tm = useTranslations('media')
  const tp = useTranslations('settings.permissions')
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
  const [permissions, setPermissions] = useState(() =>
    rolePermissions(role.permissions),
  )
  const [iconFile, setIconFile] = useState<File | null>(null)
  const iconInputRef = useRef<HTMLInputElement>(null)
  const { cropImage, cropDialog } = useImageCropper()
  const [removeIcon, setRemoveIcon] = useState(false)
  const [saving, setSaving] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const administratorEnabled = hasServerPermission(
    permissions,
    ADMINISTRATOR_PERMISSION.flag,
  )
  const canGrantAdministrator = canGrantServerPermission(
    server,
    ADMINISTRATOR_PERMISSION.flag,
  )

  const memberCount = useSyncStore((state) =>
    Object.values(state.members).filter(
      (entry) =>
        entry._id.server === server._id &&
        (entry.roles ?? []).includes(role._id),
    ).length,
  )

  const roleEditorTabs = useMemo(
    (): { id: RoleEditorTab; label: string }[] => [
      { id: 'display', label: t('tabs.display') },
      { id: 'permissions', label: t('tabs.permissions') },
      {
        id: 'members',
        label: t('tabs.members', { count: memberCount }),
      },
    ],
    [memberCount, t],
  )

  const headerRoleName = (name.trim() || role.name).toUpperCase()

  const previewIconUrl = useMemo(() => {
    if (iconFile) return URL.createObjectURL(iconFile)
    if (removeIcon) return null
    return roleIconUrl(role.icon)
  }, [iconFile, removeIcon, role.icon])

  useEffect(() => {
    setName(role.name)
    setColour(role.colour ?? '')
    setHoist(Boolean(role.hoist))
    setMentionable(role.mentionable !== false)
    setPermissions(rolePermissions(role.permissions))
    setIconFile(null)
    setRemoveIcon(false)
    setActiveTab('display')
  }, [role])

  useEffect(() => {
    const url = previewIconUrl
    if (!url?.startsWith('blob:')) return
    return () => URL.revokeObjectURL(url)
  }, [previewIconUrl])

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
    return permissions !== rolePermissions(role.permissions)
  }, [canEditPermissions, permissions, role.permissions])

  const isDirty = isRoleMetaDirty || isPermissionsDirty

  const resetDraft = useCallback((): boolean => {
    setName(role.name)
    setColour(role.colour ?? '')
    setHoist(Boolean(role.hoist))
    setMentionable(role.mentionable !== false)
    setPermissions(rolePermissions(role.permissions))
    setIconFile(null)
    setRemoveIcon(false)
    return true
  }, [role])

  const save = useCallback(async (): Promise<boolean> => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      return false
    }

    setSaving(true)
    return Effect.runPromise(
      Effect.gen(function*() {
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
          const iconAttachmentId = iconFile
            ? yield* uploadMediaFileEffect(token, 'icons', iconFile, tm)
            : undefined
          const trimmedColour = colour.trim()
          const fieldsToRemove: FieldsRole[] = []
          if (colourChanged && !trimmedColour) {
            fieldsToRemove.push('Colour')
          }
          if (removeIcon) {
            fieldsToRemove.push('Icon')
          }

          const updatedRole = yield* editServerRoleEffect(
            token,
            serverId,
            role._id,
            {
              ...(nameChanged ? { name: trimmedName } : {}),
              ...(colourChanged && trimmedColour
                ? { colour: trimmedColour }
                : {}),
              ...(hoistChanged ? { hoist } : {}),
              ...(mentionableChanged ? { mentionable } : {}),
              ...(iconAttachmentId ? { icon: iconAttachmentId } : {}),
              ...(fieldsToRemove.length > 0
                ? { remove: fieldsToRemove }
                : {}),
            },
          )
          yield* Effect.sync(() => {
            upsertServerRole(serverId, updatedRole)
            setIconFile(null)
            setRemoveIcon(false)
          })
        }

        const permissionsChanged =
          permissions !== rolePermissions(role.permissions)

        if (permissionsChanged && canEditPermissions) {
          const serverAfterPermissions =
            yield* setServerRolePermissionsEffect(
              token,
              serverId,
              role._id,
              { permissions },
            )
          yield* Effect.sync(() =>
            syncStore.upsertServer(serverAfterPermissions),
          )
        }
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.sync(() => {
            console.error('[role-editor] save failed', error)
            return false
          }),
        ),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    )
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

  return (
    <div className="space-y-6">
      <div className="space-y-0">
        <div className="flex items-center justify-between gap-4">
          <h2 className="min-w-0 truncate text-xs font-bold tracking-wide uppercase">
            {t('editTitle', { name: headerRoleName })}
          </h2>
          {canEditRole ? (
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-muted-foreground"
                    title={t('roleActions', { name: headerRoleName })}
                  />
                }
              >
                <MoreHorizontalIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-48" align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onDeleteRequested()}
                >
                  <Trash2Icon />
                  {t('deleteRole')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as typeof activeTab)}
          className="mt-4"
        >
          <TabsList variant="line" aria-label={t('sectionsAria')}>
            {roleEditorTabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {activeTab === 'display' ? (
        <div className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="role-name">
              {t('name')}
              <span className="text-destructive" aria-hidden>
                {' '}
                *
              </span>
              <span className="sr-only">{t('required')}</span>
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
              <p className="text-sm font-medium">{t('roleIcon')}</p>
              <p className="text-xs text-muted-foreground">{t('iconHint')}</p>
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
                  {t('none')}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <input
                  ref={iconInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={!canEditRole || saving}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (!file) return
                    cropImage(file, { kind: 'rect', aspect: 1 }, (cropped) => {
                      setIconFile(cropped)
                      setRemoveIcon(false)
                    })
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!canEditRole || saving}
                  onClick={() => iconInputRef.current?.click()}
                >
                  {t('upload')}
                </Button>
                {cropDialog}
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
                    {t('delete')}
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

          <div className="space-y-0">
            <SettingsToggleRow
              label={t('hoistLabel')}
              hint={t('hoistHint')}
              checked={hoist}
              disabled={!canEditRole}
              onCheckedChange={setHoist}
            />

            <SettingsToggleRow
              label={t('mentionableLabel')}
              hint={t('mentionableHint')}
              checked={mentionable}
              disabled={!canEditRole}
              onCheckedChange={setMentionable}
            />
          </div>
        </div>
      ) : null}

      {activeTab === 'permissions' ? (
        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">
              {t('permissionToggleHint')}
            </p>
          </div>

          <section className="space-y-2">
            <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {t('advancedPermissions')}
            </h4>
            <SettingsToggleRow
              label={tp(ADMINISTRATOR_PERMISSION.labelKey)}
              hint={tp(ADMINISTRATOR_PERMISSION.hintKey)}
              checked={administratorEnabled}
              disabled={
                !canEditPermissions ||
                (!canGrantAdministrator && !administratorEnabled)
              }
              onCheckedChange={(enabled) =>
                setPermissions((current) =>
                  toggleServerPermission(
                    current,
                    ADMINISTRATOR_PERMISSION.flag,
                    enabled,
                  ),
                )
              }
            />
          </section>

          {SERVER_PERMISSION_GROUPS.map((group) => (
            <section key={group.titleKey} className="space-y-2">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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
                      className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-hover"
                    >
                      <span className="text-sm">{tp(permission.labelKey)}</span>
                      <PermissionStateButton
                        label={tp(permission.labelKey)}
                        state={enabled ? 'allow' : 'neutral'}
                        allowedStates={['neutral', 'allow']}
                        mode="switch"
                        disabled={
                          !canEditPermissions ||
                          (!actorHasPermission && !enabled)
                        }
                        onChange={(next) =>
                          setPermissions((current) =>
                            toggleServerPermission(
                              current,
                              permission.flag,
                              next === 'allow',
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
      ) : null}

      {activeTab === 'members' ? (
        <RoleMembersPanel server={server} role={role} />
      ) : null}

      {!canEditRole && !canEditPermissions ? (
        <p className="text-sm text-muted-foreground">
          {t('insufficientPermissions')}
        </p>
      ) : null}
    </div>
  )
}
