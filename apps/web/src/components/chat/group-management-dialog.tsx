import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { Channel, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect, Fiber } from 'effect'

import { LogOutIcon, SettingsIcon, UserMinusIcon } from '#/components/icons'
import {
  DraftProvider,
  useDraftRegistration,
} from '#/components/settings/draft-controller-context'
import { UnsavedChangesBar } from '#/components/settings/unsaved-changes-bar'
import { UserAvatar } from '#/components/user/user-avatar'
import { useImageCropper } from '#/components/media/image-crop-dialog'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@syrnike13/ui/primitives/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@syrnike13/ui/primitives/dialog'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import {
  addGroupMemberEffect,
  deleteChannelEffect,
  editChannelEffect,
  fetchGroupMembersEffect,
  removeGroupMemberEffect,
  transferGroupOwnershipEffect,
} from '#/features/api/channels-api'
import { uploadMediaFileEffect } from '#/features/api/media-api'
import { useAuth } from '#/features/auth/auth-context'
import { canInviteUser } from '#/features/authorization/authorization'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { attachmentPreviewUrl } from '#/lib/media'

type GroupChannel = Extract<Channel, { channel_type: 'Group' }>

type GroupManagementDialogProps = {
  channel: GroupChannel
}

type PendingConfirmation =
  | { type: 'remove'; user: User }
  | { type: 'transfer'; user: User }
  | { type: 'leave'; suffix: string }

export function GroupManagementDialog({
  ...props
}: GroupManagementDialogProps) {
  return (
    <DraftProvider>
      <GroupManagementDialogContent {...props} />
    </DraftProvider>
  )
}

function GroupManagementDialogContent({
  channel,
}: GroupManagementDialogProps) {
  const t = useTranslations('chat.group')
  const tc = useTranslations('chat')
  const tm = useTranslations('media')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const users = useSyncStore((state) => state.users)
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<User[]>([])
  const [name, setName] = useState(channel.name)
  const [savedName, setSavedName] = useState(channel.name)
  const [description, setDescription] = useState(channel.description ?? '')
  const [savedDescription, setSavedDescription] = useState(
    channel.description ?? '',
  )
  const [iconFile, setIconFile] = useState<File | null>(null)
  const iconInputRef = useRef<HTMLInputElement>(null)
  const { cropImage, cropDialog } = useImageCropper()
  const [iconFilePreview, setIconFilePreview] = useState<string | null>(null)
  useEffect(() => {
    if (!iconFile) {
      setIconFilePreview(null)
      return
    }
    const url = URL.createObjectURL(iconFile)
    setIconFilePreview(url)
    return () => URL.revokeObjectURL(url)
  }, [iconFile])
  const [removeIcon, setRemoveIcon] = useState(false)
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] =
    useState<PendingConfirmation | null>(null)

  const token = auth.session?.token
  const currentUserId = auth.user?._id
  const isOwner = currentUserId === channel.owner
  const recipientKey = channel.recipients.join('\u0000')

  useEffect(() => {
    if (!open) return
    setName(channel.name)
    setSavedName(channel.name)
    setDescription(channel.description ?? '')
    setSavedDescription(channel.description ?? '')
    setIconFile(null)
    setRemoveIcon(false)
  }, [channel.description, channel.icon, channel.name, open])

  function refreshMembers() {
    if (!token) return Effect.void
    return Effect.sync(() => setLoadingMembers(true)).pipe(
      Effect.andThen(fetchGroupMembersEffect(token, channel._id)),
      Effect.tap((found) =>
        Effect.sync(() => {
          for (const user of found) syncStore.upsertUser(user)
          setMembers(found)
        }),
      ),
      Effect.catch(() =>
        Effect.sync(() => {
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          setLoadingMembers(false)
        }),
      ),
    )
  }

  useEffect(() => {
    if (!open) return
    const fiber = Effect.runFork(refreshMembers())
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [open, token, channel._id, channel.owner, recipientKey])

  const memberIds = useMemo(
    () => new Set(members.map((member) => member._id)),
    [members],
  )
  const candidates = useMemo(
    () =>
      Object.values(users)
        .filter(
          (user) =>
            user._id !== currentUserId &&
            user.relationship === 'Friend' &&
            canInviteUser(user._id) &&
            !user.bot &&
            !memberIds.has(user._id),
        )
        .sort((a, b) =>
          (a.display_name ?? a.username).localeCompare(
            b.display_name ?? b.username,
            'ru',
          ),
        ),
    [currentUserId, memberIds, users],
  )

  const isProfileDirty =
    name.trim() !== savedName.trim() ||
    description.trim() !== savedDescription.trim() ||
    iconFile !== null ||
    (removeIcon && Boolean(channel.icon))

  async function saveProfile(): Promise<boolean> {
    if (!token) return false
    const trimmedName = name.trim()
    if (!trimmedName) {
      return false
    }

    setBusy(true)
    return Effect.runPromise(
      Effect.gen(function*() {
        const data: Parameters<typeof editChannelEffect>[2] = {
          name: trimmedName,
        }
        const trimmedDescription = description.trim()
        if (trimmedDescription) {
          data.description = trimmedDescription
        } else if (channel.description) {
          data.remove = [...(data.remove ?? []), 'Description']
        }
        if (iconFile) {
          data.icon = yield* uploadMediaFileEffect(
            token,
            'icons',
            iconFile,
            tm,
          )
        } else if (removeIcon && channel.icon) {
          data.remove = [...(data.remove ?? []), 'Icon']
        }

        const updated = yield* editChannelEffect(token, channel._id, data)
        if (updated.channel_type !== 'Group') {
          return yield* Effect.fail(
            new Error(t('invalidChannel')),
          )
        }
        yield* Effect.sync(() => {
          syncStore.upsertChannel(updated)
          setName(updated.name)
          setSavedName(updated.name)
          setDescription(updated.description ?? '')
          setSavedDescription(updated.description ?? '')
          setIconFile(null)
          setRemoveIcon(false)
        })
      }).pipe(
        Effect.match({
          onFailure: () => {
            return false
          },
          onSuccess: () => true,
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    )
  }

  function resetProfileDraft() {
    setName(savedName)
    setDescription(savedDescription)
    setIconFile(null)
    setRemoveIcon(false)
    return true
  }

  useDraftRegistration(
    open
      ? {
          isDirty: isProfileDirty,
          isSaving: busy,
          save: saveProfile,
          reset: resetProfileDraft,
        }
      : null,
  )

  async function addMember(user: User) {
    if (!token) return
    setBusy(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* addGroupMemberEffect(token, channel._id, user._id)
        yield* Effect.sync(() => {
          syncStore.patchChannel(channel._id, {
            recipients: [...new Set([...channel.recipients, user._id])],
          })
        })
        yield* refreshMembers()
        yield* Effect.sync(() =>
          {},
        )
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    )
  }

  async function removeMember(user: User) {
    if (!token || !isOwner || user._id === currentUserId) return
    setBusy(true)
    await Effect.runPromise(
      removeGroupMemberEffect(token, channel._id, user._id).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            syncStore.patchChannel(channel._id, {
              recipients: channel.recipients.filter(
                (id) => id !== user._id,
              ),
            })
            setMembers((current) =>
              current.filter((item) => item._id !== user._id),
            )
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    )
  }

  async function transferOwnership(user: User) {
    if (!token || !isOwner || user._id === currentUserId) return
    setBusy(true)
    await Effect.runPromise(
      transferGroupOwnershipEffect(token, channel._id, user._id).pipe(
        Effect.tap((updated) =>
          Effect.sync(() => {
            syncStore.upsertChannel(updated)
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    )
  }

  function requestLeave() {
    if (!token) return
    const nextOwner =
      isOwner && members.length > 1
        ? members.find((member) => member._id !== currentUserId)
        : undefined
    const suffix = nextOwner
      ? t('leaveOwnerSuffix', { username: nextOwner.username })
      : ''
    setConfirmation({ type: 'leave', suffix })
  }

  async function leaveGroup() {
    if (!token) return
    setBusy(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* deleteChannelEffect(token, channel._id)
        yield* Effect.sync(() => {
          syncStore.removeChannel(channel._id)
          setOpen(false)
        })
        yield* Effect.tryPromise({
          try: () =>
            navigate({ to: prefix || '/', search: { tab: 'online' } }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            setBusy(false)
          }),
        ),
      ),
    )
  }

  const currentIconUrl =
    channel.icon && !removeIcon ? attachmentPreviewUrl(channel.icon) : null

  return (
    <>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button
          type="button"
          variant="ghost"
          size="icon"
          title={t('settings')}
          aria-label={t('settings')} />}>
          <SettingsIcon className="size-4" />
        </DialogTrigger>
      <DialogContent className="flex max-h-dialog max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('settings')}</DialogTitle>
          <DialogDescription>
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-6 overflow-y-auto pr-1">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('profile')}</h3>
            <div className="flex items-center gap-3">
              <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted text-muted-foreground">
                {iconFilePreview ? (
                  <img src={iconFilePreview} alt={t('iconAlt')} className="size-full object-cover" />
                ) : currentIconUrl ? (
                  <img src={currentIconUrl} alt={t('iconAlt')} className="size-full object-cover" />
                ) : (
                  <SettingsIcon className="size-6" />
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={iconInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (!file) return
                    cropImage(file, { kind: 'circle' }, (cropped) => {
                      setIconFile(cropped)
                      setRemoveIcon(false)
                    })
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => iconInputRef.current?.click()}
                >
                  {t('uploadIcon')}
                </Button>
                {cropDialog}
                {channel.icon || iconFile ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setIconFile(null)
                      setRemoveIcon(Boolean(channel.icon))
                    }}
                  >
                    {t('removeIcon')}
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-settings-name">{t('name')}</Label>
              <Input
                id="group-settings-name"
                value={name}
                maxLength={32}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-settings-description">{t('descriptionLabel')}</Label>
              <Textarea
                id="group-settings-description"
                value={description}
                maxLength={1024}
                disabled={busy}
                className="min-h-20 resize-y"
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{t('members')}</h3>
              <span className="text-xs text-muted-foreground">
                {loadingMembers ? t('loading') : members.length}
              </span>
            </div>
            <div className="space-y-1">
              {members.map((member) => (
                <div key={member._id} className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-muted/40">
                  <UserAvatar user={member} className="size-8" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {member.display_name ?? member.username}
                    {member._id === channel.owner ? (
                      <span className="ml-2 text-xs text-muted-foreground">{t('owner')}</span>
                    ) : null}
                  </span>
                  {isOwner && member._id !== currentUserId ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({ type: 'transfer', user: member })
                        }
                      >
                        {t('transfer')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title={t('removeMember')}
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({ type: 'remove', user: member })
                        }
                      >
                        <UserMinusIcon className="size-4" />
                      </Button>
                    </>
                  ) : null}
                </div>
              ))}
            </div>

            {candidates.length > 0 ? (
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="text-xs font-semibold text-muted-foreground">{t('addFriend')}</p>
                {candidates.map((candidate) => (
                  <div key={candidate._id} className="flex items-center gap-2">
                    <UserAvatar user={candidate} className="size-7" />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {candidate.display_name ?? candidate.username}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void addMember(candidate)}
                    >
                      {t('add')}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="border-t border-border pt-5">
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={requestLeave}
            >
              <LogOutIcon className="size-4" />
              {t('leave')}
            </Button>
          </section>
        </div>
        <UnsavedChangesBar placement="flow" />
      </DialogContent>
    </Dialog>

    <AlertDialog
      open={confirmation !== null}
      onOpenChange={(next) => {
        if (!next) setConfirmation(null)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirmation?.type === 'remove'
              ? t('removeConfirm', { username: confirmation.user.username })
              : confirmation?.type === 'transfer'
                ? t('transferConfirm', {
                    username: confirmation.user.username,
                  })
                : t('leaveConfirm', {
                    suffix:
                      confirmation?.type === 'leave' ? confirmation.suffix : '',
                  })}
          </AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tc('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant={confirmation?.type === 'transfer' ? 'default' : 'destructive'}
            onClick={() => {
              const pending = confirmation
              setConfirmation(null)
              if (!pending) return
              if (pending.type === 'remove') void removeMember(pending.user)
              else if (pending.type === 'transfer') {
                void transferOwnership(pending.user)
              } else {
                void leaveGroup()
              }
            }}
          >
            {confirmation?.type === 'remove'
              ? t('removeMember')
              : confirmation?.type === 'transfer'
                ? t('transfer')
                : t('leave')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
