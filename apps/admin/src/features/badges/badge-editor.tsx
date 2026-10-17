import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Badge } from '@syrnike13/api-types'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { BadgeIcon } from '#/components/badge-icon'
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
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { Field, FieldLabel } from '@syrnike13/ui/primitives/field'
import { Input } from '@syrnike13/ui/primitives/input'
import { Switch } from '@syrnike13/ui/primitives/switch'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import {
  assignAdminUserBadgeEffect,
  createAdminBadgeEffect,
  deleteAdminBadgeEffect,
  fetchAdminUserEffect,
  updateAdminBadgeEffect,
} from '#/features/api/admin-api'
import { uploadMediaFileEffect } from '#/features/api/media-api'
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
  const t = useTranslations('badges.editor')
  const tm = useTranslations('media')
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
    mutationFn: () =>
      Effect.runPromise(
        Effect.gen(function*() {
          if (!token) return yield* Effect.fail(new Error(t('noSession')))
          const iconFileId = iconFile
            ? yield* uploadMediaFileEffect(token, 'badges', iconFile, tm)
            : undefined
          return yield* createAdminBadgeEffect(
            token,
            formToCreatePayload(form, iconFileId),
          )
        }),
      ),
    onSuccess: (created) => {
      queryClient.setQueryData<Badge[]>(queryKeys.admin.badges, (c = []) => [
        ...c,
        created,
      ])
      toast.success(t('created'))
      void navigate({ to: '/badges/$badgeId', params: { badgeId: created._id } })
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : t('createError'))
    },
  })

  const updateMutation = useMutation({
    mutationFn: () =>
      Effect.runPromise(
        Effect.gen(function*() {
          if (!token || !badge) {
            return yield* Effect.fail(new Error(t('selectError')))
          }
          const iconFileId = iconFile
            ? yield* uploadMediaFileEffect(token, 'badges', iconFile, tm)
            : undefined
          return yield* updateAdminBadgeEffect(
            token,
            badge._id,
            formToEditPayload(form, iconFileId, removeIcon && !iconFile),
          )
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData<Badge[]>(queryKeys.admin.badges, (c = []) =>
        c.map((item) => (item._id === updated._id ? updated : item)),
      )
      setIconFile(null)
      setRemoveIcon(false)
      toast.success(t('saved'))
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : t('saveError'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () =>
      Effect.runPromise(
        Effect.gen(function*() {
          if (!token || !badge) {
            return yield* Effect.fail(new Error(t('selectError')))
          }
          yield* deleteAdminBadgeEffect(token, badge._id)
          return badge
        }),
      ),
    onSuccess: (deleted) => {
      queryClient.setQueryData<Badge[]>(queryKeys.admin.badges, (c = []) =>
        c.filter((item) => item._id !== deleted._id),
      )
      toast.success(t('deleted'))
      void navigate({ to: '/badges' })
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : t('deleteError'))
    },
  })

  const assignMutation = useMutation({
    mutationFn: () =>
      Effect.runPromise(
        Effect.gen(function*() {
          if (!token || !badge) {
            return yield* Effect.fail(new Error(t('selectError')))
          }
          const user = yield* fetchAdminUserEffect(token, assignQuery.trim())
          return yield* assignAdminUserBadgeEffect(
            token,
            user._id,
            badge._id,
          )
        }),
      ),
    onSuccess: () => {
      toast.success(t('assigned'))
      setAssignOpen(false)
      setAssignQuery('')
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : t('assignError'))
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
      title={
        mode === 'create' ? t('newBadge') : form.name || t('badgeFallback')
      }
      back={{ to: '/badges', label: t('backBadges') }}
      actions={
        mode === 'edit' ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
            <UserPlusIcon className="size-4" aria-hidden />
            {t('assign')}
          </Button>
        ) : undefined
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-5 lg:grid-cols-[1fr_16rem]">
          <AdminSection className="p-4 sm:p-5">
            <div className="grid gap-4">
              <Field>
                <FieldLabel>{t('name')}</FieldLabel>
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
              </Field>
              <Field>
                <FieldLabel>Slug</FieldLabel>
                <Input
                  value={form.slug}
                  className="font-mono"
                  onChange={(e) => {
                    setSlugTouched(true)
                    setForm({ ...form, slug: e.target.value })
                  }}
                />
              </Field>
              <Field>
                <FieldLabel>{t('description')}</FieldLabel>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel>{t('order')}</FieldLabel>
                  <Input
                    value={form.displayOrder}
                    inputMode="numeric"
                    className="font-mono"
                    onChange={(e) =>
                      setForm({ ...form, displayOrder: e.target.value })
                    }
                  />
                </Field>
                <div className="space-y-3 pt-1">
                  <SwitchRow
                    label={t('visible')}
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
                  {removeIcon ? t('cancelRemoveIcon') : t('removeIcon')}
                </Button>
              ) : null}
            </AdminSection>
            <div className="flex items-center gap-2.5 rounded-md border border-border/60 bg-card/50 px-3 py-2">
              <BadgeIcon
                badge={{ icon: removeIcon && !iconFile ? undefined : badge?.icon }}
                previewUrl={previewUrl}
                size="sm"
              />
              <div className="min-w-0 text-xs">
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
                {t('delete')}
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
              {t('reset')}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !canSave}>
              {busy ? (
                <Loader2Icon className="size-4 animate-spin" aria-hidden />
              ) : (
                <CheckIcon className="size-4" aria-hidden />
              )}
              {mode === 'create' ? t('create') : t('save')}
            </Button>
          </div>
        </AdminStickyFooter>
      </form>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent showCloseButton={!deleteMutation.isPending}>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteDescription', { name: badge?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('assignTitle')}</DialogTitle>
            <DialogDescription>{t('assignDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            value={assignQuery}
            onChange={(e) => setAssignQuery(e.target.value)}
            placeholder={t('assignPlaceholder')}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={!assignQuery.trim() || assignMutation.isPending}
              onClick={() => assignMutation.mutate()}
            >
              {t('assign')}
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
    <label className="flex items-center justify-between gap-3 text-[0.8125rem]">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  )
}
