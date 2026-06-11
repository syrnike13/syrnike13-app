import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PencilFillIcon } from '#/components/icons'
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
import { FxImage } from '#/components/ui/fx-image'
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
import {
  useProfileDraftRegistration,
  type ProfileDraftController,
} from '#/components/settings/profile-draft-context'
import { cn } from '#/lib/utils'

type ProfileBaseline = {
  displayName: string
  statusText: string
  bio: string
}

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
  const savedBaselineRef = useRef<ProfileBaseline>({
    displayName: '',
    statusText: '',
    bio: '',
  })

  const commitSavedBaseline = useCallback((next: ProfileBaseline) => {
    savedBaselineRef.current = {
      displayName: next.displayName,
      statusText: next.statusText,
      bio: next.bio,
    }
  }, [])
  const saveInFlightRef = useRef(false)
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
  const [isSaving, setIsSaving] = useState(false)
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
        commitSavedBaseline({
          ...savedBaselineRef.current,
          bio: content,
        })
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
    commitSavedBaseline(nextBaseline)
    setDisplayName(nextBaseline.displayName)
    setStatusText(nextBaseline.statusText)
    setBio(nextBaseline.bio)
    setAvatarPreviewOverride(undefined)
    setBannerPreviewOverride(undefined)
    setHydrated(true)
    setIsSaving(false)
  }, [
    hydrated,
    profileQuery.data?.content,
    profileQuery.isFetched,
    profileReady,
    commitSavedBaseline,
    user,
  ])

  const avatarPreview = useMemo(() => {
    if (avatarPreviewOverride !== undefined) {
      return avatarPreviewOverride
    }
    return userAvatarUrl(user?.avatar ?? null, { animated: true })
  }, [avatarPreviewOverride, user?.avatar])

  const bannerPreview = useMemo(() => {
    if (bannerPreviewOverride !== undefined) {
      return bannerPreviewOverride
    }
    return userBannerUrl(profileQuery.data?.background ?? null, {
      animated: true,
    })
  }, [bannerPreviewOverride, profileQuery.data?.background])

  useEffect(() => {
    return () => {
      revokeObjectUrl(avatarPreview)
      revokeObjectUrl(bannerPreview)
    }
  }, [avatarPreview, bannerPreview])

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
      setIsSaving(true)

      try {
        await updateCurrentUser(token, patch)
        await auth.refreshUser()
        await queryClient.invalidateQueries({
          queryKey: queryKeys.users.profile(user._id),
        })
        return true
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось сохранить профиль',
        )
        return false
      } finally {
        saveInFlightRef.current = false
        setIsSaving(false)
      }
    },
    [auth, queryClient, token, user],
  )

  const resetTextFields = useCallback((): boolean => {
    const saved = savedBaselineRef.current
    const wasDirty =
      displayName.trim() !== saved.displayName.trim() ||
      statusText.trim() !== saved.statusText.trim() ||
      bio.trim() !== saved.bio.trim()

    if (!wasDirty) return false

    setDisplayName(saved.displayName)
    setStatusText(saved.statusText)
    setBio(saved.bio)
    return true
  }, [bio, displayName, statusText])

  const saveTextFields = useCallback(async (): Promise<boolean> => {
    if (!user) return false

    const parsed = profileSchema.safeParse({
      display_name: displayName,
      status_text: statusText,
      bio,
    })
    if (!parsed.success) {
      toast.error('Проверьте поля профиля')
      return false
    }

    const trimmedName = parsed.data.display_name.trim()
    if (trimmedName.length > 0 && trimmedName.length < 2) {
      toast.error('Имя должно быть не короче 2 символов')
      return false
    }

    const baseline = savedBaselineRef.current
    const changes: DataEditUser = { remove: [] }
    const remove = changes.remove as FieldsUser[]

    if (trimmedName !== baseline.displayName.trim()) {
      changes.display_name = trimmedName.length ? trimmedName : null
    }

    const trimmedStatus = parsed.data.status_text.trim()
    if (trimmedStatus !== baseline.statusText.trim()) {
      changes.status = {
        text: trimmedStatus.length ? trimmedStatus : null,
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
    if (!ok) return false

    commitSavedBaseline({
      displayName: trimmedName,
      statusText: trimmedStatus,
      bio: trimmedBio,
    })
    setDisplayName(trimmedName)
    setStatusText(trimmedStatus)
    setBio(trimmedBio)
    return true
  }, [bio, commitSavedBaseline, displayName, persistProfile, statusText, user])

  const saved = savedBaselineRef.current
  const textDirty =
    hydrated &&
    (displayName.trim() !== saved.displayName.trim() ||
      statusText.trim() !== saved.statusText.trim() ||
      bio.trim() !== saved.bio.trim())

  const draftRegistration = useMemo((): ProfileDraftController | null => {
    if (!hydrated) return null
    return {
      isDirty: textDirty,
      isSaving,
      save: saveTextFields,
      reset: resetTextFields,
    }
  }, [hydrated, textDirty, isSaving, saveTextFields, resetTextFields])

  useProfileDraftRegistration(draftRegistration)

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

  const mediaBusy = isSaving
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
            <FxImage
              src={bannerUrl}
              wrapperClassName="block h-full w-full"
              className="h-full w-full"
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
            <div className="group/profile-avatar relative size-16 overflow-hidden rounded-full">
              {avatarUrl ? (
                <FxImage
                  src={avatarUrl}
                  rounded="full"
                  wrapperClassName="size-16 rounded-full ring-4 ring-card"
                  className="size-16"
                />
              ) : (
                <UserAvatar
                  user={{ ...user, avatar: null }}
                  className="size-16"
                  fallbackClassName="size-16 bg-card text-lg ring-4 ring-card"
                  showPresence={false}
                />
              )}
              <ProfileMediaEditOverlay
                label={hasAvatar ? 'Изменить аватар' : 'Добавить аватар'}
                disabled={mediaBusy}
                onClick={onEditAvatar}
                className="rounded-full group-hover/profile-avatar:opacity-100"
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
        'group-hover/banner:opacity-100',
        'focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-0',
        className,
      )}
    >
      <PencilFillIcon className="size-5 text-white drop-shadow-sm" aria-hidden />
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
