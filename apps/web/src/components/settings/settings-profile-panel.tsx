import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PencilFillIcon } from '#/components/icons'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import type { DataEditUser, FieldsUser, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { toast } from 'sonner'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import { FxImage } from '#/components/ui/fx-image'
import { UserAvatar } from '#/components/user/user-avatar'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import { uploadMediaFileEffect } from '#/features/api/media-api'
import {
  fetchUserProfile,
  updateCurrentUserEffect,
} from '#/features/api/users-api'
import { useAuth } from '#/features/auth/auth-context'
import { profileSchema, validateForm } from '#/features/auth/schemas'
import { queryKeys } from '#/lib/api/query-keys'
import { userAvatarUrl, userBannerUrl } from '#/lib/media'
import { userProfileBannerClassName } from '#/lib/user-profile-banner'
import {
  useProfileDraftRegistration,
  type ProfileDraftController,
} from '#/components/settings/profile-draft-context'
import {
  ProfileStatusBubbleTrigger,
  SettingsProfileStatusDialog,
} from '#/components/settings/settings-profile-status-dialog'
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
  const t = useTranslations('settings.profile')
  const tValidation = useTranslations('validation')
  const tm = useTranslations('media')
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
    queryFn: ({ signal }) => fetchUserProfile(token!, user!._id, signal),
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
  const [statusDialogOpen, setStatusDialogOpen] = useState(false)

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
    (patch: DataEditUser) =>
      Effect.suspend(() => {
        if (!token || !user || saveInFlightRef.current) {
          return Effect.succeed(false)
        }

        const remove = patch.remove ?? []
        const hasChange =
          patch.display_name !== undefined ||
          patch.avatar !== undefined ||
          patch.status !== undefined ||
          patch.profile !== undefined ||
          remove.length > 0

        if (!hasChange) return Effect.succeed(true)

        return Effect.sync(() => {
          saveInFlightRef.current = true
          setIsSaving(true)
        }).pipe(
          Effect.andThen(
            Effect.gen(function*() {
              yield* updateCurrentUserEffect(token, patch)
              yield* auth.refreshUser()
              yield* Effect.tryPromise({
                try: () =>
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.users.profile(user._id),
                  }),
                catch: (cause) => cause,
              })
              return true
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : t('saveError'),
              )
              return false
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              saveInFlightRef.current = false
              setIsSaving(false)
            }),
          ),
        )
      }),
    [auth, queryClient, t, token, user],
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

    const parsed = validateForm(profileSchema, {
      display_name: displayName,
      status_text: statusText,
      bio,
    })
    if (!parsed.success) {
      toast.error(tValidation(parsed.issues[0]?.message ?? 'profileFields'))
      return false
    }

    const trimmedName = parsed.data.display_name.trim()
    if (trimmedName.length > 0 && trimmedName.length < 2) {
      toast.error(tValidation('profileNameMin'))
      return false
    }

    const baseline = savedBaselineRef.current
    const remove: FieldsUser[] = []
    const changes: DataEditUser = { remove }

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

    const ok = await Effect.runPromise(persistProfile(changes))
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

      await Effect.runPromise(
        uploadMediaFileEffect(token, 'avatars', file, tm).pipe(
          Effect.flatMap((avatarId) => persistProfile({ avatar: avatarId })),
          Effect.tap((saved) =>
            saved
              ? Effect.sync(() => setAvatarPreviewOverride(undefined))
              : Effect.succeed(undefined),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              setAvatarPreviewOverride(undefined)
              toast.error(
                error instanceof Error
                  ? error.message
                  : t('avatarUploadError'),
              )
            }),
          ),
        ),
      )
    },
    [persistProfile, t, tm, token, user],
  )

  const removeAvatar = useCallback(async () => {
    if (!token || !user?.avatar) return
    setAvatarPreviewOverride(null)
    const ok = await Effect.runPromise(
      persistProfile({ remove: ['Avatar'] }),
    )
    if (ok) {
      setAvatarPreviewOverride(undefined)
    }
  }, [persistProfile, token, user?.avatar])

  const uploadBanner = useCallback(
    async (file: File) => {
      if (!token || !user) return
      const preview = URL.createObjectURL(file)
      setBannerPreviewOverride(preview)

      await Effect.runPromise(
        uploadMediaFileEffect(token, 'backgrounds', file, tm).pipe(
          Effect.flatMap((backgroundId) =>
            persistProfile({
              profile: { background: backgroundId },
            }),
          ),
          Effect.tap((saved) =>
            saved
              ? Effect.sync(() => setBannerPreviewOverride(undefined))
              : Effect.succeed(undefined),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              setBannerPreviewOverride(undefined)
              toast.error(
                error instanceof Error
                  ? error.message
                  : t('bannerUploadError'),
              )
            }),
          ),
        ),
      )
    },
    [persistProfile, t, tm, token, user],
  )

  const removeBanner = useCallback(async () => {
    if (!token || !profileQuery.data?.background) return
    setBannerPreviewOverride(null)
    const ok = await Effect.runPromise(
      persistProfile({ remove: ['ProfileBackground'] }),
    )
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
    <div className="grid gap-8 max-lg:grid-cols-1 settings-profile-grid">
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

      <div className="order-2 space-y-6 lg:order-1">
        <section className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="profile-display-name">{t('displayName')}</Label>
            <Input
              id="profile-display-name"
              value={displayName}
              maxLength={32}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={t('displayNamePlaceholder')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-username">{t('username')}</Label>
            <Input
              id="profile-username"
              value={`@${username}`}
              disabled
              className="text-muted-foreground"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-bio">{t('bio')}</Label>
            <Textarea
              id="profile-bio"
              value={bio}
              rows={4}
              maxLength={2000}
              onChange={(event) => setBio(event.target.value)}
              placeholder={t('bioPlaceholder')}
            />
          </div>
        </section>
      </div>

      <aside className="order-1 lg:order-2 lg:sticky lg:top-0 lg:self-start">
        <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t('preview')}
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
          onEditStatus={() => setStatusDialogOpen(true)}
        />
      </aside>

      <SettingsProfileStatusDialog
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
        statusText={statusText}
        onApply={setStatusText}
        user={user}
        displayName={displayName.trim() || username}
        username={username}
        avatarUrl={avatarPreview}
        bannerUrl={bannerPreview}
      />
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
  onEditStatus,
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
  onEditStatus: () => void
}) {
  const t = useTranslations('settings.profile')

  return (
    <div className="gradient-surface-card overflow-visible rounded-xl border border-border bg-card shadow-sm">
      <ProfileMediaContextMenu
        editLabel={t('editBanner')}
        removeLabel={t('removeBanner')}
        disabled={mediaBusy}
        onEdit={onEditBanner}
        onRemove={onRemoveBanner}
      >
        <div
          className={userProfileBannerClassName(
            'group/banner overflow-hidden rounded-t-xl',
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
            label={hasBanner ? t('editBanner') : t('addBanner')}
            disabled={mediaBusy}
            onClick={onEditBanner}
            className="rounded-none"
          />
        </div>
      </ProfileMediaContextMenu>
      <div className="relative px-4 pb-4">
        <div className="-mt-8 mb-2 w-fit">
          <ProfileMediaContextMenu
            editLabel={t('editAvatar')}
            removeLabel={t('removeAvatar')}
            disabled={mediaBusy}
            onEdit={onEditAvatar}
            onRemove={onRemoveAvatar}
          >
            <div className="relative size-16">
              <div className="group/profile-avatar relative size-16">
                <UserAvatar
                  user={avatarUrl ? user : { ...user, avatar: null }}
                  imageSrc={avatarUrl}
                  className="size-16 ring-4 ring-card bg-card text-lg"
                  showPresence={false}
                />
                <ProfileMediaEditOverlay
                  label={hasAvatar ? t('editAvatar') : t('addAvatar')}
                  disabled={mediaBusy}
                  onClick={onEditAvatar}
                  className="rounded-full group-hover/profile-avatar:opacity-100"
                />
              </div>
              <ProfileStatusBubbleTrigger
                status={statusText}
                onClick={onEditStatus}
                className="left-full top-48/100 ml-1.5"
              />
            </div>
          </ProfileMediaContextMenu>
        </div>
        <p className="truncate text-base font-semibold">{displayName}</p>
        <p className="truncate text-sm text-muted-foreground">@{username}</p>
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
        'absolute inset-0 flex cursor-pointer items-center justify-center border-0 bg-scrim opacity-0 transition-opacity',
        'group-hover/banner:opacity-100',
        'focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-0',
        className,
      )}
    >
      <PencilFillIcon className="size-5 text-on-scrim drop-shadow-sm" aria-hidden />
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
  children: ReactElement
  editLabel: string
  removeLabel: string
  disabled: boolean
  onEdit: () => void
  onRemove?: () => void
}) {
  if (disabled) return children

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent>
        <ContextMenuItem onClick={onEdit}>{editLabel}</ContextMenuItem>
        {onRemove ? (
          <ContextMenuItem variant="destructive" onClick={onRemove}>
            {removeLabel}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
