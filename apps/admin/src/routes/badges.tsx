import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type {
  Badge,
  DataCreateBadge,
  DataEditBadge,
  FieldsBadge,
  User,
} from '@syrnike13/api-types'
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import {
  CheckIcon,
  FolderPlusIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UserPlusIcon,
  XIcon,
} from '#/components/icons'
import { AdminShell } from '#/components/admin-shell'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Switch } from '#/components/ui/switch'
import { Textarea } from '#/components/ui/textarea'
import { AuthedGate } from '#/features/auth/authed-gate'
import { useAuth } from '#/features/auth/auth-context'
import {
  assignAdminUserBadge,
  createAdminBadge,
  deleteAdminBadge,
  fetchAdminBadges,
  fetchAdminUser,
  fetchAdminUserBadges,
  removeAdminUserBadge,
  updateAdminBadge,
} from '#/features/api/admin-api'
import { uploadMediaFile } from '#/features/api/media-api'
import { queryKeys } from '#/lib/api/query-keys'
import { badgeIconUrl } from '#/lib/media'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/badges')({
  component: BadgesRoute,
})

function BadgesRoute() {
  return (
    <AuthedGate>
      <AdminShell>
        <AdminBadgesPage />
      </AdminShell>
    </AuthedGate>
  )
}

type BadgeFormState = {
  slug: string
  name: string
  description: string
  visible: boolean
  premium: boolean
  displayOrder: string
}

const emptyForm: BadgeFormState = {
  slug: '',
  name: '',
  description: '',
  visible: true,
  premium: false,
  displayOrder: '0',
}

function badgeToForm(badge: Badge): BadgeFormState {
  return {
    slug: badge.slug,
    name: badge.name,
    description: badge.description ?? '',
    visible: badge.visible ?? false,
    premium: badge.premium ?? false,
    displayOrder: String(badge.display_order),
  }
}

function formToCreatePayload(form: BadgeFormState, iconFileId?: string): DataCreateBadge {
  return {
    slug: form.slug.trim(),
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    icon_file_id: iconFileId,
    visible: form.visible,
    premium: form.premium,
    display_order: Number.parseInt(form.displayOrder, 10) || 0,
  }
}

function formToEditPayload(
  form: BadgeFormState,
  iconFileId?: string,
  removeIcon = false,
): DataEditBadge {
  const description = form.description.trim()
  const remove: FieldsBadge[] = []

  if (!description) {
    remove.push('Description')
  }

  if (removeIcon) {
    remove.push('Icon')
  }

  return {
    slug: form.slug.trim(),
    name: form.name.trim(),
    description: description || undefined,
    icon_file_id: iconFileId,
    visible: form.visible,
    premium: form.premium,
    display_order: Number.parseInt(form.displayOrder, 10) || 0,
    remove,
  }
}

export function AdminBadgesPage() {
  const auth = useAuth()
  const token = auth.session?.token
  const queryClient = useQueryClient()
  const [selectedBadgeId, setSelectedBadgeId] = useState<string | null>(null)
  const [form, setForm] = useState<BadgeFormState>(emptyForm)
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [removeIcon, setRemoveIcon] = useState(false)
  const [userQuery, setUserQuery] = useState('')
  const [selectedUser, setSelectedUser] = useState<User | null>(null)

  const badgesQuery = useQuery({
    queryKey: queryKeys.admin.badges,
    queryFn: () => fetchAdminBadges(token!),
    enabled: Boolean(token),
  })

  const userBadgesQuery = useQuery({
    queryKey: selectedUser
      ? queryKeys.admin.userBadges(selectedUser._id)
      : queryKeys.admin.userBadges(''),
    queryFn: () => fetchAdminUserBadges(token!, selectedUser!._id),
    enabled: Boolean(token && selectedUser),
  })

  const badges = badgesQuery.data ?? []
  const selectedBadge = badges.find((badge) => badge._id === selectedBadgeId) ?? null
  const assignedBadgeIds = useMemo(
    () => new Set((userBadgesQuery.data ?? []).map((badge) => badge._id)),
    [userBadgesQuery.data],
  )

  const resetForm = () => {
    setSelectedBadgeId(null)
    setForm(emptyForm)
    setIconFile(null)
    setRemoveIcon(false)
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('Нет сессии')
      const iconFileId = iconFile
        ? await uploadMediaFile(token, 'badges', iconFile)
        : undefined
      return createAdminBadge(token, formToCreatePayload(form, iconFileId))
    },
    onSuccess: (badge) => {
      queryClient.setQueryData<Badge[]>(queryKeys.admin.badges, (current = []) => [
        ...current,
        badge,
      ])
      setSelectedBadgeId(badge._id)
      setForm(badgeToForm(badge))
      setIconFile(null)
      setRemoveIcon(false)
      toast.success('Бейдж создан')
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Не удалось создать бейдж')
    },
  })

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!token || !selectedBadge) throw new Error('Бейдж не выбран')
      const iconFileId = iconFile
        ? await uploadMediaFile(token, 'badges', iconFile)
        : undefined
      return updateAdminBadge(
        token,
        selectedBadge._id,
        formToEditPayload(form, iconFileId, removeIcon && !iconFile),
      )
    },
    onSuccess: (badge) => {
      queryClient.setQueryData<Badge[]>(queryKeys.admin.badges, (current = []) =>
        current.map((item) => (item._id === badge._id ? badge : item)),
      )
      setForm(badgeToForm(badge))
      setIconFile(null)
      setRemoveIcon(false)
      toast.success('Бейдж сохранён')
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить бейдж')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (badge: Badge) => {
      if (!token) throw new Error('Нет сессии')
      await deleteAdminBadge(token, badge._id)
      return badge
    },
    onSuccess: (badge) => {
      queryClient.setQueryData<Badge[]>(queryKeys.admin.badges, (current = []) =>
        current.filter((item) => item._id !== badge._id),
      )
      resetForm()
      if (selectedUser) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.admin.userBadges(selectedUser._id),
        })
      }
      toast.success('Бейдж удалён')
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Не удалось удалить бейдж')
    },
  })

  const findUserMutation = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('Нет сессии')
      return fetchAdminUser(token, userQuery.trim())
    },
    onSuccess: (user) => {
      setSelectedUser(user)
      toast.success('Пользователь найден')
    },
    onError: (error) => {
      setSelectedUser(null)
      toast.error(error instanceof Error ? error.message : 'Пользователь не найден')
    },
  })

  const assignMutation = useMutation({
    mutationFn: async (badge: Badge) => {
      if (!token || !selectedUser) throw new Error('Пользователь не выбран')
      return assignAdminUserBadge(token, selectedUser._id, badge._id)
    },
    onSuccess: (assigned) => {
      if (!selectedUser) return
      queryClient.setQueryData(queryKeys.admin.userBadges(selectedUser._id), assigned)
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Не удалось выдать бейдж')
    },
  })

  const removeMutation = useMutation({
    mutationFn: async (badge: Badge) => {
      if (!token || !selectedUser) throw new Error('Пользователь не выбран')
      return removeAdminUserBadge(token, selectedUser._id, badge._id)
    },
    onSuccess: (assigned) => {
      if (!selectedUser) return
      queryClient.setQueryData(queryKeys.admin.userBadges(selectedUser._id), assigned)
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Не удалось снять бейдж')
    },
  })

  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold leading-tight">Бейджи</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Каталог, иконки и выдача пользователям
          </p>
        </div>
        <Button type="button" variant="outline" onClick={resetForm}>
          <PlusIcon className="size-4" aria-hidden />
          Новый бейдж
        </Button>
      </header>

      <div className="grid min-h-[calc(100svh-9rem)] grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(22rem,0.9fr)]">
        <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <div className="min-w-[36rem]">
              <div className="grid grid-cols-[3rem_minmax(8rem,1fr)_7rem_7rem_5rem] border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <span>Icon</span>
                <span>Бейдж</span>
                <span>Visible</span>
                <span>Premium</span>
                <span>Order</span>
              </div>
              <div className="divide-y divide-border">
                {badgesQuery.isLoading ? (
                  <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                    <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden />
                    Загрузка
                  </div>
                ) : badges.length === 0 ? (
                  <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                    Каталог пуст
                  </div>
                ) : (
                  badges.map((badge) => (
                    <button
                      key={badge._id}
                      type="button"
                      className={cn(
                        'grid w-full grid-cols-[3rem_minmax(8rem,1fr)_7rem_7rem_5rem] items-center px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60',
                        selectedBadgeId === badge._id &&
                          'bg-accent text-accent-foreground',
                      )}
                      onClick={() => {
                        setSelectedBadgeId(badge._id)
                        setForm(badgeToForm(badge))
                        setIconFile(null)
                        setRemoveIcon(false)
                      }}
                    >
                      <BadgeIconPreview badge={badge} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{badge.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {badge.slug}
                        </span>
                      </span>
                      <BooleanCell value={badge.visible ?? false} />
                      <BooleanCell value={badge.premium ?? false} />
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {badge.display_order}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>

        <aside className="flex min-w-0 flex-col gap-5">
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">
              {selectedBadge ? 'Редактировать бейдж' : 'Создать бейдж'}
            </h2>
            <div className="mt-4 grid gap-3">
              <Field label="Slug">
                <Input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} />
              </Field>
              <Field label="Название">
                <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              </Field>
              <Field label="Описание">
                <Textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
              </Field>
              <Field label="Order">
                <Input value={form.displayOrder} inputMode="numeric" onChange={(event) => setForm({ ...form, displayOrder: event.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <SwitchRow label="Visible" checked={form.visible} onCheckedChange={(visible) => setForm({ ...form, visible })} />
                <SwitchRow label="Premium" checked={form.premium} onCheckedChange={(premium) => setForm({ ...form, premium })} />
              </div>
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-dashed border-border px-3 py-2 text-sm transition-colors hover:bg-accent/50">
                <span className="min-w-0 truncate text-muted-foreground">
                  {iconFile
                    ? iconFile.name
                    : removeIcon
                      ? 'Иконка будет очищена'
                      : 'PNG/WebP icon'}
                </span>
                <span className="inline-flex items-center gap-2 font-medium">
                  <FolderPlusIcon className="size-4" aria-hidden />
                  Загрузить
                </span>
                <input
                  type="file"
                  accept="image/png,image/webp"
                  className="sr-only"
                  onChange={(event) => {
                    setIconFile(event.target.files?.[0] ?? null)
                    setRemoveIcon(false)
                  }}
                />
              </label>
              {selectedBadge?.icon || removeIcon ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setIconFile(null)
                    setRemoveIcon((current) => !current)
                  }}
                >
                  <XIcon className="size-4" aria-hidden />
                  {removeIcon ? 'Не очищать иконку' : 'Очистить иконку'}
                </Button>
              ) : null}
              <div className="flex justify-between gap-2 pt-1">
                {selectedBadge ? (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => {
                      if (!selectedBadge) return
                      if (!window.confirm(`Удалить бейдж «${selectedBadge.name}»?`)) return
                      deleteMutation.mutate(selectedBadge)
                    }}
                  >
                    <Trash2Icon className="size-4" aria-hidden />
                    Удалить
                  </Button>
                ) : <span />}
                <Button
                  type="button"
                  disabled={busy || !form.slug.trim() || !form.name.trim()}
                  onClick={() => {
                    if (selectedBadge) updateMutation.mutate()
                    else createMutation.mutate()
                  }}
                >
                  {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden /> : <CheckIcon className="size-4" aria-hidden />}
                  Сохранить
                </Button>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Выдача пользователю</h2>
            <form
              className="mt-4 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (userQuery.trim()) findUserMutation.mutate()
              }}
            >
              <Input
                value={userQuery}
                placeholder="user id или username#0001"
                onChange={(event) => setUserQuery(event.target.value)}
              />
              <Button type="submit" size="icon" disabled={findUserMutation.isPending}>
                {findUserMutation.isPending ? (
                  <Loader2Icon className="size-4 animate-spin" aria-hidden />
                ) : (
                  <SearchIcon className="size-4" aria-hidden />
                )}
              </Button>
            </form>
            {selectedUser ? (
              <div className="mt-4">
                <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
                  <p className="font-medium">{selectedUser.display_name ?? selectedUser.username}</p>
                  <p className="text-xs text-muted-foreground">
                    @{selectedUser.username} · {selectedUser._id}
                  </p>
                </div>
                <div className="mt-3 grid gap-1.5">
                  {badges.map((badge) => {
                    const assigned = assignedBadgeIds.has(badge._id)
                    return (
                      <div
                        key={badge._id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-sm"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <BadgeIconPreview badge={badge} small />
                          <span className="truncate">{badge.name}</span>
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant={assigned ? 'outline' : 'default'}
                          disabled={assignMutation.isPending || removeMutation.isPending}
                          onClick={() => {
                            if (assigned) removeMutation.mutate(badge)
                            else assignMutation.mutate(badge)
                          }}
                        >
                          {assigned ? <XIcon className="size-3.5" aria-hidden /> : <UserPlusIcon className="size-3.5" aria-hidden />}
                          {assigned ? 'Снять' : 'Выдать'}
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
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
    <label className="flex h-10 items-center justify-between rounded-md border border-border px-3 text-sm">
      {label}
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  )
}

function BadgeIconPreview({ badge, small = false }: { badge: Badge; small?: boolean }) {
  const iconUrl = badgeIconUrl(badge.icon)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md bg-muted text-[10px] text-muted-foreground',
        small ? 'size-7' : 'size-9',
      )}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="size-5 object-contain" />
      ) : (
        '-'
      )}
    </span>
  )
}

function BooleanCell({ value }: { value: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', value ? 'text-emerald-500' : 'text-muted-foreground')}>
      {value ? <CheckIcon className="size-3.5" aria-hidden /> : <XIcon className="size-3.5" aria-hidden />}
      {value ? 'yes' : 'no'}
    </span>
  )
}
