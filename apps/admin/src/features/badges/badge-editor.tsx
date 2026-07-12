import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Badge } from '@syrnike13/api-types'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { BadgeIcon } from '#/components/badge-icon'
import { FormField } from '#/components/form-field'
import { IconDropzone } from '#/components/icon-dropzone'
import {
  AdminPage,
  AdminSection,
  AdminStickyFooter,
} from '#/components/layout/page'
import {
  CheckIcon,
  Loader2Icon,
  Trash2Icon,
  UserPlusIcon,
  XIcon,
} from '#/components/icons'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Switch } from '#/components/ui/switch'
import { Textarea } from '#/components/ui/textarea'
import {
  assignAdminUserBadge,
  createAdminBadge,
  deleteAdminBadge,
  fetchAdminUser,
  updateAdminBadge,
} from '#/features/api/admin-api'
import { uploadMediaFile } from '#/features/api/media-api'
import {
  emptyBadgeForm,
  formToCreatePayload,
  formToEditPayload,
  isBadgeFormDirty,
  suggestBadgeSlug,
  type BadgeFormState,
} from '#/features/badges/badge-form'
import { useAuth } from '#/features/auth/auth-context'
import { queryKeys } from '#/lib/api/query-keys'
import { badgeIconUrl } from '#/lib/media'

export function BadgeEditorPage({
  mode,
  badge,
}: {
  mode: 'create' | 'edit'
  badge?: Badge
}) {
  const auth = useAuth()
  const token = auth.session?.token
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const baseline = useMemo(
    () => (badge ? formFromBadge(badge) : emptyBadgeForm),
    [badge],
  )

  const [form, setForm] = useState<BadgeFormState>(baseline)
  const [slugTouched, setSlugTouched] = useState(mode === 'edit')
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [removeIcon, setRemoveIcon] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignQuery, setAssignQuery] = useState('')

  const dirty = isBadgeFormDirty(form, baseline, iconFile, removeIcon)

  useEffect(() => {
    setForm(baseline)
    setIconFile(null)
    setRemoveIcon(false)
    setSlugTouched(mode === 'edit')
  }, [baseline, mode])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const previewUrl = useMemo(() => {
    if (iconFile) return URL.createObjectURL(iconFile)
    if (removeIcon) return null
    return badge ? badgeIconUrl(badge.icon) : null
  }, [badge, iconFile, removeIcon])

  useEffect(() => {
    if (!iconFile) return
    return () => URL.revokeObjectURL(previewUrl ?? '')
  }, [iconFile, previewUrl])

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('Нет сессии')
      const iconFileId = iconFile
        ? await uploadMediaFile(token, 'badges', iconFile)
        : undefined
      return createAdminBadge(token, formToCreatePayload(form, iconFileId))
    },
    onSuccess: (created) => {
      queryClient.setQueryData<Badge[]>(queryKeys.admin.badges, (c = []) => [
        ...c,
        created,
      ])
      toast.success('Бейдж создан')
      void navigate({ to: '/badges/$badgeId', params: { badgeId: created._id } })
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Не удалось создать бейдж')
    },
  })

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!token || !badge) throw new Error('Бейдж не выбран')
      const iconFileId = iconFile
        ? await uploadMediaFile(token, 'badges', iconFile)
        : undefined
      return updateAdminBadge(
        token,
        badge._id,
        formToEditPayload(form, iconFileId, removeIcon && !iconFile),
      )
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<Badge[]>(queryKeys.admin.badges, (c = []) =>
        c.map((item) => (item._id === updated._id ? updated : item)),
      )
      setIconFile(null)
      setRemoveIcon(false)
      toast.success('Сохранено')
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!token || !badge) throw new Error('Бейдж не выбран')
      await deleteAdminBadge(token, badge._id)
      return badge
    },
    onSuccess: (deleted) => {
      queryClient.setQueryData<Badge[]>(queryKeys.admin.badges, (c = []) =>
        c.filter((item) => item._id !== deleted._id),
      )
      toast.success('Удалено')
      void navigate({ to: '/badges' })
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить')
    },
  })

  const assignMutation = useMutation({
    mutationFn: async () => {
      if (!token || !badge) throw new Error('Бейдж не выбран')
      const user = await fetchAdminUser(token, assignQuery.trim())
      return assignAdminUserBadge(token, user._id, badge._id)
    },
    onSuccess: () => {
      toast.success('Выдано')
      setAssignOpen(false)
      setAssignQuery('')
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Не удалось выдать')
    },
  })

  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending

  const canSave = Boolean(form.slug.trim() && form.name.trim())

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSave || busy) return
    if (mode === 'create') createMutation.mutate()
    else updateMutation.mutate()
  }

  return (
    <AdminPage
      title={mode === 'create' ? 'Новый бейдж' : form.name || 'Бейдж'}
      back={{ to: '/badges', label: 'Бейджи' }}
      actions={
        mode === 'edit' ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
            <UserPlusIcon className="size-4" aria-hidden />
            Выдать
          </Button>
        ) : undefined
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-5 lg:grid-cols-[1fr_16rem]">
          <AdminSection className="p-4 sm:p-5">
            <div className="grid gap-4">
              <FormField label="Название">
                <Input
                  value={form.name}
                  onChange={(e) => {
                    const name = e.target.value
                    setForm((c) => ({
                      ...c,
                      name,
                      slug:
                        !slugTouched && mode === 'create'
                          ? suggestBadgeSlug(name)
                          : c.slug,
                    }))
                  }}
                />
              </FormField>
              <FormField label="Slug">
                <Input
                  value={form.slug}
                  className="font-mono"
                  onChange={(e) => {
                    setSlugTouched(true)
                    setForm({ ...form, slug: e.target.value })
                  }}
                />
              </FormField>
              <FormField label="Описание">
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                />
              </FormField>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Порядок">
                  <Input
                    value={form.displayOrder}
                    inputMode="numeric"
                    className="font-mono"
                    onChange={(e) =>
                      setForm({ ...form, displayOrder: e.target.value })
                    }
                  />
                </FormField>
                <div className="space-y-3 pt-1">
                  <SwitchRow
                    label="Видимый"
                    checked={form.visible}
                    onCheckedChange={(visible) => setForm({ ...form, visible })}
                  />
                  <SwitchRow
                    label="Premium"
                    checked={form.premium}
                    onCheckedChange={(premium) => setForm({ ...form, premium })}
                  />
                </div>
              </div>
            </div>
          </AdminSection>

          <div className="space-y-3">
            <AdminSection className="p-4">
              <IconDropzone
                file={iconFile}
                previewUrl={previewUrl}
                disabled={busy}
                onFileChange={(file) => {
                  setIconFile(file)
                  setRemoveIcon(false)
                }}
              />
              {mode === 'edit' && (badge?.icon || removeIcon) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full"
                  disabled={busy}
                  onClick={() => {
                    setIconFile(null)
                    setRemoveIcon((c) => !c)
                  }}
                >
                  <XIcon className="size-4" aria-hidden />
                  {removeIcon ? 'Отменить удаление' : 'Удалить иконку'}
                </Button>
              ) : null}
            </AdminSection>
            <div className="flex items-center gap-2.5 rounded-md border border-border/60 bg-card/50 px-3 py-2">
              <BadgeIcon
                badge={{ icon: removeIcon && !iconFile ? undefined : badge?.icon }}
                previewUrl={previewUrl}
                size="sm"
              />
              <div className="min-w-0 text-[12px]">
                <div className="truncate font-medium">{form.name || '—'}</div>
                <div className="truncate text-muted-foreground">@username</div>
              </div>
            </div>
          </div>
        </div>

        <AdminStickyFooter visible={dirty}>
          <div className="flex gap-2">
            {mode === 'edit' ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2Icon className="size-4" aria-hidden />
                Удалить
              </Button>
            ) : (
              <span />
            )}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setForm(baseline)
                setIconFile(null)
                setRemoveIcon(false)
              }}
            >
              Сбросить
            </Button>
            <Button type="submit" size="sm" disabled={busy || !canSave}>
              {busy ? (
                <Loader2Icon className="size-4 animate-spin" aria-hidden />
              ) : (
                <CheckIcon className="size-4" aria-hidden />
              )}
              {mode === 'create' ? 'Создать' : 'Сохранить'}
            </Button>
          </div>
        </AdminStickyFooter>
      </form>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent showCloseButton={!deleteMutation.isPending}>
          <DialogHeader>
            <DialogTitle>Удалить бейдж?</DialogTitle>
            <DialogDescription>
              «{badge?.name}» будет удалён вместе с выдачами.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              Удалить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Выдать бейдж</DialogTitle>
            <DialogDescription>User id или username#0001</DialogDescription>
          </DialogHeader>
          <Input
            value={assignQuery}
            onChange={(e) => setAssignQuery(e.target.value)}
            placeholder="user id или username#0001"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>
              Отмена
            </Button>
            <Button
              disabled={!assignQuery.trim() || assignMutation.isPending}
              onClick={() => assignMutation.mutate()}
            >
              Выдать
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}

function formFromBadge(badge: Badge): BadgeFormState {
  return {
    slug: badge.slug,
    name: badge.name,
    description: badge.description ?? '',
    visible: badge.visible ?? false,
    premium: badge.premium ?? false,
    displayOrder: String(badge.display_order),
  }
}

function SwitchRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-[13px]">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  )
}
