import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, Loader2Icon, PencilIcon } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { DataEditUser, FieldsUser, User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '#/components/ui/context-menu'
import { UserAvatar } from '#/components/user/user-avatar'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Textarea } from '#/components/ui/textarea'
import { uploadMediaFile } from '#/features/api/media-api'
import { fetchUserProfile, updateCurrentUser } from '#/features/api/users-api'
import { useAuth } from '#/features/auth/auth-context'
import { profileSchema } from '#/features/auth/schemas'
import { queryKeys } from '#/lib/api/query-keys'
import { userAvatarUrl, userBannerUrl } from '#/lib/media'
import { cn } from '#/lib/utils'

const TEXT_AUTOSAVE_MS = 700

type ProfileBaseline = {
  displayName: string
  statusText: string
  bio: string
}

type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

function revokeObjectUrl(url: string | null) {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url)
  }
}

export function SettingsProfilePanel() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const user = auth.user
  const token = auth.session?.token

  const avatarInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const baselineRef = useRef<ProfileBaseline>({
    displayName: '',
    statusText: '',
    bio: '',
  })
  const saveInFlightRef = useRef(false)
  const savedFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hydratedUserIdRef = useRef<string | null>(null)
  const profileBioSyncedRef = useRef(false)

  const profileQuery = useQuery({
    queryKey: queryKeys.users.profile(user?._id ?? ''),
    queryFn: () => fetchUserProfile(token!, user!._id),
    enabled: Boolean(token && user?._id),
    staleTime: 30_000,
  })

  const [displayName, setDisplayName] = useState('')
  const [statusText, setStatusText] = useState('')
  const [bio, setBio] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [avatarPreviewOverride, setAvatarPreviewOverride] = useState<
    string | null | undefined
  >(undefined)
  const [bannerPreviewOverride, setBannerPreviewOverride] = useState<
    string | null | undefined
  >(undefined)

  const profileReady =
    Boolean(user) && (profileQuery.isFetched || !profileQuery.isLoading)

  useEffect(() => {
    if (!user || !profileReady) {
      setHydrated(false)
      hydratedUserIdRef.current = null
      profileBioSyncedRef.current = false
      return
    }

    const userChanged = hydratedUserIdRef.current !== user._id
    if (!userChanged && hydrated) {
      if (!profileBioSyncedRef.current && profileQuery.isFetched) {
        const content = profileQuery.data?.content ?? ''
        setBio(content)
        baselineRef.current.bio = content
        profileBioSyncedRef.current = true
      }
      return
    }

    hydratedUserIdRef.current = user._id
    profileBioSyncedRef.current = profileQuery.isFetched

    const nextBaseline: ProfileBaseline = {
      displayName: user.display_name ?? '',
      statusText: user.status?.text ?? '',
      bio: profileQuery.data?.content ?? '',
    }
    baselineRef.current = nextBaseline
    setDisplayName(nextBaseline.displayName)
    setStatusText(nextBaseline.statusText)
    setBio(nextBaseline.bio)
    setAvatarPreviewOverride(undefined)
    setBannerPreviewOverride(undefined)
    setHydrated(true)
    setSaveStatus('idle')
  }, [
    hydrated,
    profileQuery.data?.content,
    profileQuery.isFetched,
    profileReady,
    user,
  ])

  const avatarPreview = useMemo(() => {
    if (avatarPreviewOverride !== undefined) {
      return avatarPreviewOverride
    }
    return userAvatarUrl(user?.avatar ?? null)
  }, [avatarPreviewOverride, user?.avatar])

  const bannerPreview = useMemo(() => {
    if (bannerPreviewOverride !== undefined) {
      return bannerPreviewOverride
    }
    return userBannerUrl(profileQuery.data?.background ?? null)
  }, [bannerPreviewOverride, profileQuery.data?.background])

  useEffect(() => {
    return () => {
      revokeObjectUrl(avatarPreview)
      revokeObjectUrl(bannerPreview)
      if (savedFadeRef.current) clearTimeout(savedFadeRef.current)
    }
  }, [avatarPreview, bannerPreview])

  const markSaved = useCallback(() => {
    setSaveStatus('saved')
    if (savedFadeRef.current) clearTimeout(savedFadeRef.current)
    savedFadeRef.current = setTimeout(() => {
      setSaveStatus('idle')
    }, 2000)
  }, [])

  const persistProfile = useCallback(
    async (patch: DataEditUser) => {
      if (!token || !user || saveInFlightRef.current) return false

      const remove = (patch.remove ?? []) as FieldsUser[]
      const hasChange =
        patch.display_name !== undefined ||
        patch.avatar !== undefined ||
        patch.status !== undefined ||
        patch.profile !== undefined ||
        remove.length > 0

      if (!hasChange) return true

      saveInFlightRef.current = true
      setSaveStatus('saving')

      try {
        await updateCurrentUser(token, patch)
        await auth.refreshUser()
        await queryClient.invalidateQueries({
          queryKey: queryKeys.users.profile(user._id),
        })
        markSaved()
        return true
      } catch (error) {
        setSaveStatus('error')
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось сохранить профиль',
        )
        return false
      } finally {
        saveInFlightRef.current = false
      }
    },
    [auth, markSaved, queryClient, token, user],
  )

  const saveTextFields = useCallback(async () => {
    if (!user) return

    const parsed = profileSchema.safeParse({
      display_name: displayName,
      status_text: statusText,
      bio,
    })
    if (!parsed.success) {
      setSaveStatus('error')
      return
    }

    const trimmedName = parsed.data.display_name.trim()
    if (trimmedName.length > 0 && trimmedName.length < 2) {
      setSaveStatus('error')
      return
    }

    const baseline = baselineRef.current
    const changes: DataEditUser = { remove: [] }
    const remove = changes.remove as FieldsUser[]

    if (trimmedName !== baseline.displayName.trim()) {
      changes.display_name = trimmedName.length ? trimmedName : null
    }

    const trimmedStatus = parsed.data.status_text.trim()
    if (trimmedStatus !== baseline.statusText.trim()) {
      changes.status = {
        text: trimmedStatus.length ? trimmedStatus : null,
        presence: user.status?.presence ?? 'Online',
      }
    }

    const trimmedBio = parsed.data.bio.trim()
    if (trimmedBio !== baseline.bio.trim()) {
      if (!trimmedBio) {
        remove.push('ProfileContent')
      } else {
        changes.profile = { ...changes.profile, content: trimmedBio }
      }
    }

    const ok = await persistProfile(changes)
    if (!ok) return

    baselineRef.current = {
      displayName: trimmedName,
      statusText: trimmedStatus,
      bio: trimmedBio,
    }
  }, [bio, displayName, persistProfile, statusText, user])

  useEffect(() => {
    if (!hydrated || !token) return

    const baseline = baselineRef.current
    const textDirty =
      displayName.trim() !== baseline.displayName.trim() ||
      statusText.trim() !== baseline.statusText.trim() ||
      bio.trim() !== baseline.bio.trim()

    if (!textDirty) return

    setSaveStatus((current) => (current === 'saving' ? current : 'pending'))
    const timer = window.setTimeout(() => {
      void saveTextFields()
    }, TEXT_AUTOSAVE_MS)

    return () => window.clearTimeout(timer)
  }, [bio, displayName, hydrated, saveTextFields, statusText, token])

  const uploadAvatar = useCallback(
    async (file: File) => {
      if (!token || !user) return
      const preview = URL.createObjectURL(file)
      setAvatarPreviewOverride(preview)

      try {
        const avatarId = await uploadMediaFile(token, 'avatars', file)
        const ok = await persistProfile({ avatar: avatarId })
        if (ok) setAvatarPreviewOverride(undefined)
      } catch (error) {
        setAvatarPreviewOverride(undefined)
        toast.error(
          error instanceof Error ? error.message : 'Не удалось загрузить аватар',
        )
      }
    },
    [persistProfile, token, user],
  )

  const removeAvatar = useCallback(async () => {
    if (!token || !user?.avatar) return
    setAvatarPreviewOverride(null)
    const ok = await persistProfile({ remove: ['Avatar'] })
    if (ok) {
      setAvatarPreviewOverride(undefined)
    }
  }, [persistProfile, token, user?.avatar])

  const uploadBanner = useCallback(
    async (file: File) => {
      if (!token || !user) return
      const preview = URL.createObjectURL(file)
      setBannerPreviewOverride(preview)

      try {
        const backgroundId = await uploadMediaFile(token, 'backgrounds', file)
        const ok = await persistProfile({
          profile: { background: backgroundId },
        })
        if (ok) setBannerPreviewOverride(undefined)
      } catch (error) {
        setBannerPreviewOverride(undefined)
        toast.error(
          error instanceof Error ? error.message : 'Не удалось загрузить баннер',
        )
      }
    },
    [persistProfile, token, user],
  )

  const removeBanner = useCallback(async () => {
    if (!token || !profileQuery.data?.background) return
    setBannerPreviewOverride(null)
    const ok = await persistProfile({ remove: ['ProfileBackground'] })
    if (ok) {
      setBannerPreviewOverride(undefined)
    }
  }, [persistProfile, profileQuery.data?.background, token])

  if (!user) return null

  const username = user.username

  const mediaBusy = saveStatus === 'saving'
  const hasAvatar =
    Boolean(user.avatar) ||
    avatarPreviewOverride !== undefined ||
    Boolean(avatarPreview)
  const hasBanner =
    Boolean(profileQuery.data?.background) ||
    bannerPreviewOverride !== undefined ||
    Boolean(bannerPreview)

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (!file) return
          void uploadAvatar(file)
          event.target.value = ''
        }}
      />
      <input
        ref={bannerInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (!file) return
          void uploadBanner(file)
          event.target.value = ''
        }}
      />

      <div className="space-y-6">
        <SaveStatusLine status={saveStatus} />

        <section className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="profile-display-name">Отображаемое имя</Label>
            <Input
              id="profile-display-name"
              value={displayName}
              maxLength={32}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Как вас видят другие"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-username">Имя пользователя</Label>
            <Input
              id="profile-username"
              value={`@${username}`}
              disabled
              className="text-muted-foreground"
            />
            <p className="text-xs text-muted-foreground">
              Смена @username — в разделе «Аккаунт» (скоро).
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-status">Статус</Label>
            <Input
              id="profile-status"
              value={statusText}
              maxLength={128}
              onChange={(event) => setStatusText(event.target.value)}
              placeholder="Чем заняты?"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-bio">О себе</Label>
            <Textarea
              id="profile-bio"
              value={bio}
              rows={4}
              maxLength={2000}
              onChange={(event) => setBio(event.target.value)}
              placeholder="Расскажите о себе…"
            />
          </div>
        </section>
      </div>

      <aside className="lg:sticky lg:top-0 lg:self-start">
        <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Предпросмотр
        </p>
        <ProfilePreviewCard
          displayName={displayName.trim() || username}
          username={username}
          statusText={statusText.trim()}
          bio={bio.trim()}
          avatarUrl={avatarPreview}
          bannerUrl={bannerPreview}
          user={user}
          mediaBusy={mediaBusy}
          hasAvatar={hasAvatar}
          hasBanner={hasBanner}
          onEditAvatar={() => avatarInputRef.current?.click()}
          onEditBanner={() => bannerInputRef.current?.click()}
          onRemoveAvatar={
            hasAvatar && user.avatar ? () => void removeAvatar() : undefined
          }
          onRemoveBanner={
            hasBanner && profileQuery.data?.background
              ? () => void removeBanner()
              : undefined
          }
        />
      </aside>
    </div>
  )
}

function SaveStatusLine({ status }: { status: SaveStatus }) {
  if (status === 'idle') return null

  return (
    <p
      className={cn(
        'flex items-center gap-1.5 text-xs',
        status === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {status === 'pending' || status === 'saving' ? (
        <>
          <Loader2Icon className="size-3.5 animate-spin" />
          Сохранение…
        </>
      ) : null}
      {status === 'saved' ? (
        <>
          <CheckIcon className="size-3.5 text-[#23a559]" />
          Сохранено
        </>
      ) : null}
      {status === 'error' ? 'Не удалось сохранить — проверьте поля' : null}
    </p>
  )
}

function ProfilePreviewCard({
  displayName,
  username,
  statusText,
  bio,
  avatarUrl,
  bannerUrl,
  user,
  mediaBusy,
  hasAvatar,
  hasBanner,
  onEditAvatar,
  onEditBanner,
  onRemoveAvatar,
  onRemoveBanner,
}: {
  displayName: string
  username: string
  statusText: string
  bio: string
  avatarUrl: string | null
  bannerUrl: string | null
  user: User
  mediaBusy: boolean
  hasAvatar: boolean
  hasBanner: boolean
  onEditAvatar: () => void
  onEditBanner: () => void
  onRemoveAvatar?: () => void
  onRemoveBanner?: () => void
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <ProfileMediaContextMenu
        editLabel="Изменить баннер"
        removeLabel="Удалить баннер"
        disabled={mediaBusy}
        onEdit={onEditBanner}
        onRemove={onRemoveBanner}
      >
        <div
          className={cn(
            'group/banner relative h-[88px] w-full',
            !bannerUrl &&
              'bg-gradient-to-br from-primary/30 via-chart-4/20 to-sidebar-primary/40',
          )}
        >
          {bannerUrl ? (
            <img
              src={bannerUrl}
              alt=""
              className="size-full object-cover"
              aria-hidden
            />
          ) : null}
          <ProfileMediaEditOverlay
            label={hasBanner ? 'Изменить баннер' : 'Добавить баннер'}
            disabled={mediaBusy}
            onClick={onEditBanner}
            className="rounded-none"
          />
        </div>
      </ProfileMediaContextMenu>
      <div className="relative px-4 pb-4">
        <div className="-mt-8 mb-2 w-fit">
          <ProfileMediaContextMenu
            editLabel="Изменить аватар"
            removeLabel="Удалить аватар"
            disabled={mediaBusy}
            onEdit={onEditAvatar}
            onRemove={onRemoveAvatar}
          >
            <div className="group/avatar relative size-16">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  className="size-16 rounded-full border-4 border-card object-cover"
                />
              ) : (
                <UserAvatar
                  user={{ ...user, avatar: null }}
                  className="size-16 border-4 border-card"
                  fallbackClassName="size-16 text-lg"
                  showPresence={false}
                />
              )}
              <ProfileMediaEditOverlay
                label={hasAvatar ? 'Изменить аватар' : 'Добавить аватар'}
                disabled={mediaBusy}
                onClick={onEditAvatar}
                className="rounded-full"
              />
            </div>
          </ProfileMediaContextMenu>
        </div>
        <p className="truncate text-base font-semibold">{displayName}</p>
        <p className="truncate text-sm text-muted-foreground">@{username}</p>
        {statusText ? (
          <p className="mt-2 text-sm text-muted-foreground">{statusText}</p>
        ) : null}
        {bio ? (
          <p className="mt-2 line-clamp-4 text-sm leading-relaxed">{bio}</p>
        ) : null}
      </div>
    </div>
  )
}

function ProfileMediaEditOverlay({
  label,
  disabled,
  onClick,
  className,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        'absolute inset-0 flex cursor-pointer items-center justify-center border-0 bg-black/55 opacity-0 transition-opacity',
        'group-hover/banner:opacity-100 group-hover/avatar:opacity-100',
        'focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-0',
        className,
      )}
    >
      <PencilIcon className="size-5 text-white drop-shadow-sm" aria-hidden />
    </button>
  )
}

function ProfileMediaContextMenu({
  children,
  editLabel,
  removeLabel,
  disabled,
  onEdit,
  onRemove,
}: {
  children: ReactNode
  editLabel: string
  removeLabel: string
  disabled: boolean
  onEdit: () => void
  onRemove?: () => void
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onEdit}>{editLabel}</ContextMenuItem>
        {onRemove ? (
          <ContextMenuItem variant="destructive" onSelect={onRemove}>
            {removeLabel}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
