import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DataEditUser, FieldsUser } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { toast } from 'sonner'

import {
  ProfileBody,
  ProfileHeader,
  ProfileName,
  ProfileSurface,
} from '#/components/user/profile/profile-parts'
import { useImageCropper } from '#/components/media/image-crop-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@syrnike13/ui/primitives/field'
import { Input } from '@syrnike13/ui/primitives/input'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import { uploadMediaFileEffect } from '#/features/api/media-api'
import {
  fetchUserProfile,
  updateCurrentUserEffect,
} from '#/features/api/users-api'
import { useAuth } from '#/features/auth/auth-context'
import { profileSchema, validateForm } from '#/features/auth/schemas'
import { apiErrorMessage } from '#/lib/api/error-message'
import { queryKeys } from '#/lib/api/query-keys'
import { userAvatarUrl, userBannerUrl } from '#/lib/media'
import {
  useProfileDraftRegistration,
  type ProfileDraftController,
} from '#/components/settings/profile-draft-context'
import { SettingsProfileStatusDialog } from '#/components/settings/settings-profile-status-dialog'

/** Profile banners show at 300×105 (popover) and 400×140 (dialog). */
const PROFILE_BANNER_ASPECT = 17 / 6

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
  const { cropImage, cropDialog } = useImageCropper()
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
                apiErrorMessage(error, t('saveError')),
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
                apiErrorMessage(error, t('avatarUploadError')),
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
                apiErrorMessage(error, t('bannerUploadError')),
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
          event.target.value = ''
          if (!file) return
          cropImage(file, { kind: 'circle' }, (cropped) => void uploadAvatar(cropped))
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
          event.target.value = ''
          if (!file) return
          cropImage(
            file,
            { kind: 'rect', aspect: PROFILE_BANNER_ASPECT },
            (cropped) => void uploadBanner(cropped),
          )
        }}
      />

      <FieldGroup className="order-2 lg:order-1">
        <Field>
          <FieldLabel htmlFor="profile-display-name">{t('displayName')}</FieldLabel>
          <Input
            id="profile-display-name"
            value={displayName}
            maxLength={32}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder={t('displayNamePlaceholder')}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="profile-username">{t('username')}</FieldLabel>
          <Input id="profile-username" value={`@${username}`} disabled />
        </Field>
        <Field>
          <FieldLabel htmlFor="profile-bio">{t('bio')}</FieldLabel>
          <Textarea
            id="profile-bio"
            value={bio}
            rows={4}
            maxLength={2000}
            onChange={(event) => setBio(event.target.value)}
            placeholder={t('bioPlaceholder')}
          />
        </Field>
      </FieldGroup>

      <aside className="order-1 flex flex-col gap-2 lg:order-2 lg:sticky lg:top-0 lg:self-start">
        <FieldTitle>{t('preview')}</FieldTitle>
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div className="overflow-hidden rounded-lg bg-popover ring-1 ring-foreground/10" />
            }
          >
            <ProfileSurface surface="popover">
            <ProfileHeader
              user={{
                ...user,
                status: { ...user.status, text: statusText.trim() || null },
              }}
              bannerSrc={bannerPreview}
              avatarSrc={avatarPreview}
              editable
              avatarLabel={hasAvatar ? t('editAvatar') : t('addAvatar')}
              bannerLabel={hasBanner ? t('editBanner') : t('addBanner')}
              onAvatarClick={
                mediaBusy ? undefined : () => avatarInputRef.current?.click()
              }
              onBannerClick={
                mediaBusy ? undefined : () => bannerInputRef.current?.click()
              }
              onStatusClick={() => setStatusDialogOpen(true)}
            />
            <ProfileBody>
              <ProfileName
                user={{ ...user, display_name: displayName.trim() || null }}
              />
              {bio.trim() ? (
                <p className="line-clamp-4 text-sm whitespace-pre-wrap">{bio.trim()}</p>
              ) : null}
            </ProfileBody>
            </ProfileSurface>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              disabled={mediaBusy}
              onClick={() => avatarInputRef.current?.click()}
            >
              {hasAvatar ? t('editAvatar') : t('addAvatar')}
            </ContextMenuItem>
            {hasAvatar && user.avatar ? (
              <ContextMenuItem
                variant="destructive"
                disabled={mediaBusy}
                onClick={() => void removeAvatar()}
              >
                {t('removeAvatar')}
              </ContextMenuItem>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={mediaBusy}
              onClick={() => bannerInputRef.current?.click()}
            >
              {hasBanner ? t('editBanner') : t('addBanner')}
            </ContextMenuItem>
            {hasBanner && profileQuery.data?.background ? (
              <ContextMenuItem
                variant="destructive"
                disabled={mediaBusy}
                onClick={() => void removeBanner()}
              >
                {t('removeBanner')}
              </ContextMenuItem>
            ) : null}
          </ContextMenuContent>
        </ContextMenu>

        {cropDialog}
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
