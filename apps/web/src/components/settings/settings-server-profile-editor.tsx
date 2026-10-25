import type {
  DataMemberEdit,
  FieldsMember,
  ProfileColours,
} from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useImageCropper } from '#/components/media/image-crop-dialog'
import {
  useProfileDraftRegistration,
  type ProfileDraftController,
} from '#/components/settings/profile-draft-context'
import {
  ProfileBody,
  ProfileHeader,
  ProfileName,
  ProfileSurface,
} from '#/components/user/profile/profile-parts'
import { ProfileColoursField } from '#/components/user/profile/profile-colours-field'
import { useUserProfileData } from '#/components/user/use-user-profile-data'
import { uploadMediaFileEffect } from '#/features/api/media-api'
import { editServerMemberEffect } from '#/features/api/servers-api'
import { useAuth } from '#/features/auth/auth-context'
import { listServers } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { useServerProfile } from '#/features/users/use-server-profile'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@syrnike13/ui/primitives/field'
import { Input } from '@syrnike13/ui/primitives/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@syrnike13/ui/primitives/select'
import { Textarea } from '@syrnike13/ui/primitives/textarea'

/** Same banner geometry as the global profile. */
const PROFILE_BANNER_ASPECT = 17 / 6

type ServerProfileDraft = {
  nickname: string
  bio: string
  colours: ProfileColours | null
}

function sameDraft(a: ServerProfileDraft, b: ServerProfileDraft) {
  return (
    a.nickname.trim() === b.nickname.trim() &&
    a.bio.trim() === b.bio.trim() &&
    a.colours?.primary === b.colours?.primary &&
    a.colours?.accent === b.colours?.accent
  )
}

/**
 * Per-server profile, like Discord's server profiles: every field falls back
 * to the global profile when left empty.
 */
export function SettingsServerProfileEditor() {
  const t = useTranslations('settings.serverProfile')
  const tp = useTranslations('settings.profile')
  const tm = useTranslations('media')
  const auth = useAuth()
  const user = auth.user
  const token = auth.session?.token
  const servers = useSyncStore((state) => listServers(state))
  const [serverId, setServerId] = useState<string | undefined>(
    () => servers[0]?._id,
  )
  const activeServerId = servers.some((server) => server._id === serverId)
    ? serverId
    : servers[0]?._id

  const member = useSyncStore((state) =>
    activeServerId && user
      ? state.members[`${activeServerId}:${user._id}`]
      : undefined,
  )
  const serverProfile = useServerProfile(activeServerId, user?._id ?? '')
  const globalProfile = useUserProfileData(user?._id ?? '')

  const savedPrimary = member?.colours?.primary
  const savedAccent = member?.colours?.accent
  const saved = useMemo(
    (): ServerProfileDraft => ({
      nickname: member?.nickname ?? '',
      bio: member?.bio ?? '',
      colours:
        savedPrimary && savedAccent
          ? { primary: savedPrimary, accent: savedAccent }
          : null,
    }),
    [member?.bio, member?.nickname, savedAccent, savedPrimary],
  )
  const [draft, setDraft] = useState<ServerProfileDraft>(saved)
  const [isSaving, setIsSaving] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const { cropImage, cropDialog } = useImageCropper()

  useEffect(() => {
    setDraft(saved)
  }, [saved])

  const edit = useCallback(
    (data: DataMemberEdit) =>
      Effect.suspend(() => {
        if (!token || !user || !activeServerId) return Effect.succeed(false)
        return Effect.sync(() => setIsSaving(true)).pipe(
          Effect.andThen(
            editServerMemberEffect(token, activeServerId, user._id, data),
          ),
          Effect.tap((updated) =>
            Effect.sync(() => syncStore.upsertMembers([updated])),
          ),
          Effect.as(true),
          Effect.catch((error) =>
            Effect.sync(() => {
              console.error('[server-profile] save failed', error)
              return false
            }),
          ),
          Effect.ensuring(Effect.sync(() => setIsSaving(false))),
        )
      }),
    [activeServerId, token, user],
  )

  const save = useCallback(async (): Promise<boolean> => {
    const remove: FieldsMember[] = []
    const data: DataMemberEdit = { remove }
    const nickname = draft.nickname.trim()
    const bio = draft.bio.trim()

    if (nickname !== saved.nickname.trim()) {
      if (nickname) data.nickname = nickname
      else remove.push('Nickname')
    }
    if (bio !== saved.bio.trim()) {
      if (bio) data.bio = bio
      else remove.push('Bio')
    }
    if (
      draft.colours?.primary !== saved.colours?.primary ||
      draft.colours?.accent !== saved.colours?.accent
    ) {
      if (draft.colours) data.colours = draft.colours
      else remove.push('Colours')
    }

    return Effect.runPromise(edit(data))
  }, [draft, edit, saved])

  const reset = useCallback((): boolean => {
    if (sameDraft(draft, saved)) return false
    setDraft(saved)
    return true
  }, [draft, saved])

  const draftRegistration = useMemo(
    (): ProfileDraftController => ({
      isDirty: !sameDraft(draft, saved),
      isSaving,
      save,
      reset,
    }),
    [draft, isSaving, reset, save, saved],
  )
  useProfileDraftRegistration(draftRegistration)

  const uploadImage = useCallback(
    (tag: 'avatars' | 'backgrounds', file: File) => {
      if (!token) return
      void Effect.runPromise(
        uploadMediaFileEffect(token, tag, file, tm).pipe(
          Effect.flatMap((id) =>
            edit(tag === 'avatars' ? { avatar: id } : { banner: id }),
          ),
          Effect.catch(() => Effect.succeed(false)),
        ),
      )
    },
    [edit, tm, token],
  )

  if (!user) return null

  if (servers.length === 0 || !activeServerId) {
    return (
      <Empty size="default">
        <EmptyDescription>{t('noServers')}</EmptyDescription>
      </Empty>
    )
  }

  const previewUser = {
    ...user,
    display_name: draft.nickname.trim() || user.display_name,
  }
  const previewBio = draft.bio.trim() || globalProfile.bio

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
          cropImage(file, { kind: 'circle' }, (cropped) =>
            uploadImage('avatars', cropped),
          )
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
            (cropped) => uploadImage('backgrounds', cropped),
          )
        }}
      />

      <FieldGroup className="order-2 lg:order-1">
        <Field>
          <FieldLabel>{t('server')}</FieldLabel>
          <Select
            items={servers.map((server) => ({
              value: server._id,
              label: server.name,
            }))}
            value={activeServerId}
            onValueChange={(next) => {
              if (next != null) setServerId(next)
            }}
          >
            <SelectTrigger aria-label={t('server')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {servers.map((server) => (
                  <SelectItem key={server._id} value={server._id}>
                    {server.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>{t('hint')}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="server-profile-nickname">
            {t('nickname')}
          </FieldLabel>
          <Input
            id="server-profile-nickname"
            value={draft.nickname}
            maxLength={32}
            placeholder={user.display_name ?? user.username}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                nickname: event.target.value,
              }))
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="server-profile-bio">{tp('bio')}</FieldLabel>
          <Textarea
            id="server-profile-bio"
            value={draft.bio}
            rows={4}
            maxLength={2000}
            placeholder={globalProfile.bio ?? tp('bioPlaceholder')}
            onChange={(event) =>
              setDraft((current) => ({ ...current, bio: event.target.value }))
            }
          />
        </Field>
        <ProfileColoursField
          value={draft.colours}
          onChange={(colours) =>
            setDraft((current) => ({ ...current, colours }))
          }
        />
      </FieldGroup>

      <aside className="order-1 flex flex-col gap-2 lg:order-2 lg:sticky lg:top-0 lg:self-start">
        <FieldTitle>{tp('preview')}</FieldTitle>
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div className="overflow-hidden rounded-lg bg-popover ring-1 ring-foreground/10" />
            }
          >
            <ProfileSurface
              surface="popover"
              colours={draft.colours ?? globalProfile.colours}
            >
              <ProfileHeader
                user={user}
                bannerSrc={serverProfile?.bannerUrl ?? undefined}
                avatarSrc={serverProfile?.avatarUrl ?? undefined}
                editable
                avatarLabel={tp('editAvatar')}
                bannerLabel={tp('editBanner')}
                onAvatarClick={
                  isSaving ? undefined : () => avatarInputRef.current?.click()
                }
                onBannerClick={
                  isSaving ? undefined : () => bannerInputRef.current?.click()
                }
              />
              <ProfileBody>
                <ProfileName user={previewUser} />
                {previewBio ? (
                  <p className="line-clamp-4 text-sm whitespace-pre-wrap">
                    {previewBio}
                  </p>
                ) : null}
              </ProfileBody>
            </ProfileSurface>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              disabled={isSaving}
              onClick={() => avatarInputRef.current?.click()}
            >
              {tp('editAvatar')}
            </ContextMenuItem>
            {member?.avatar ? (
              <ContextMenuItem
                variant="destructive"
                disabled={isSaving}
                onClick={() => void Effect.runPromise(edit({ remove: ['Avatar'] }))}
              >
                {tp('removeAvatar')}
              </ContextMenuItem>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={isSaving}
              onClick={() => bannerInputRef.current?.click()}
            >
              {tp('editBanner')}
            </ContextMenuItem>
            {member?.banner ? (
              <ContextMenuItem
                variant="destructive"
                disabled={isSaving}
                onClick={() => void Effect.runPromise(edit({ remove: ['Banner'] }))}
              >
                {tp('removeBanner')}
              </ContextMenuItem>
            ) : null}
          </ContextMenuContent>
        </ContextMenu>
        {cropDialog}
      </aside>
    </div>
  )
}
