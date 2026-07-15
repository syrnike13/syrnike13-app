import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { Channel, User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { LogOutIcon, SettingsIcon, UserMinusIcon } from '#/components/icons'
import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Textarea } from '#/components/ui/textarea'
import {
  addGroupMember,
  deleteChannel,
  editChannel,
  fetchGroupMembers,
  removeGroupMember,
  transferGroupOwnership,
} from '#/features/api/channels-api'
import { uploadMediaFile } from '#/features/api/media-api'
import { useAuth } from '#/features/auth/auth-context'
import { canInviteUser } from '#/features/authorization/authorization'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { attachmentPreviewUrl } from '#/lib/media'

type GroupChannel = Extract<Channel, { channel_type: 'Group' }>

type GroupManagementDialogProps = {
  channel: GroupChannel
}

export function GroupManagementDialog({
  channel,
}: GroupManagementDialogProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const users = useSyncStore((state) => state.users)
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<User[]>([])
  const [name, setName] = useState(channel.name)
  const [description, setDescription] = useState(channel.description ?? '')
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [removeIcon, setRemoveIcon] = useState(false)
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [busy, setBusy] = useState(false)

  const token = auth.session?.token
  const currentUserId = auth.user?._id
  const isOwner = currentUserId === channel.owner
  const recipientKey = channel.recipients.join('\u0000')

  useEffect(() => {
    if (!open) return
    setName(channel.name)
    setDescription(channel.description ?? '')
    setIconFile(null)
    setRemoveIcon(false)
  }, [channel.description, channel.icon, channel.name, open])

  async function refreshMembers() {
    if (!token) return
    setLoadingMembers(true)
    try {
      const found = await fetchGroupMembers(token, channel._id)
      for (const user of found) syncStore.upsertUser(user)
      setMembers(found)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось загрузить участников',
      )
    } finally {
      setLoadingMembers(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void refreshMembers()
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

  async function saveProfile() {
    if (!token) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      toast.error('Название группы не может быть пустым')
      return
    }

    setBusy(true)
    try {
      const data: Parameters<typeof editChannel>[2] = {
        name: trimmedName,
      }
      const trimmedDescription = description.trim()
      if (trimmedDescription) {
        data.description = trimmedDescription
      } else if (channel.description) {
        data.remove = [...(data.remove ?? []), 'Description']
      }
      if (iconFile) {
        data.icon = await uploadMediaFile(token, 'icons', iconFile)
      } else if (removeIcon && channel.icon) {
        data.remove = [...(data.remove ?? []), 'Icon']
      }

      const updated = await editChannel(token, channel._id, data)
      syncStore.upsertChannel(updated)
      setIconFile(null)
      setRemoveIcon(false)
      toast.success('Группа обновлена')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить')
    } finally {
      setBusy(false)
    }
  }

  async function addMember(user: User) {
    if (!token) return
    setBusy(true)
    try {
      await addGroupMember(token, channel._id, user._id)
      syncStore.patchChannel(channel._id, {
        recipients: [...new Set([...channel.recipients, user._id])],
      } as Partial<Channel>)
      await refreshMembers()
      toast.success(`${user.display_name ?? user.username} добавлен`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось добавить')
    } finally {
      setBusy(false)
    }
  }

  async function removeMember(user: User) {
    if (!token || !isOwner || user._id === currentUserId) return
    if (!window.confirm(`Удалить @${user.username} из группы?`)) return
    setBusy(true)
    try {
      await removeGroupMember(token, channel._id, user._id)
      syncStore.patchChannel(channel._id, {
        recipients: channel.recipients.filter((id) => id !== user._id),
      } as Partial<Channel>)
      setMembers((current) => current.filter((item) => item._id !== user._id))
      toast.success('Участник удалён')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось удалить')
    } finally {
      setBusy(false)
    }
  }

  async function transferOwnership(user: User) {
    if (!token || !isOwner || user._id === currentUserId) return
    if (!window.confirm(`Передать группу @${user.username}?`)) return
    setBusy(true)
    try {
      const updated = await transferGroupOwnership(token, channel._id, user._id)
      syncStore.upsertChannel(updated)
      toast.success('Владелец группы изменён')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось передать группу')
    } finally {
      setBusy(false)
    }
  }

  async function leaveGroup() {
    if (!token) return
    const nextOwner =
      isOwner && members.length > 1
        ? members.find((member) => member._id !== currentUserId)
        : undefined
    const suffix = nextOwner
      ? ` Владелец станет @${nextOwner.username}.`
      : ''
    if (!window.confirm(`Выйти из группы?${suffix}`)) return
    setBusy(true)
    try {
      await deleteChannel(token, channel._id)
      syncStore.removeChannel(channel._id)
      setOpen(false)
      await navigate({ to: `${prefix}`, search: { tab: 'online' } })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось выйти')
      setBusy(false)
    }
  }

  const currentIconUrl =
    channel.icon && !removeIcon ? attachmentPreviewUrl(channel.icon) : null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          title="Настройки группы"
          aria-label="Настройки группы"
        >
          <SettingsIcon className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Настройки группы</DialogTitle>
          <DialogDescription>
            Профиль группы, участники и владение.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-6 overflow-y-auto pr-1">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Профиль</h3>
            <div className="flex items-center gap-3">
              <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted text-muted-foreground">
                {iconFile ? (
                  <span className="px-2 text-center text-xs">{iconFile.name}</span>
                ) : currentIconUrl ? (
                  <img src={currentIconUrl} alt="Иконка группы" className="size-full object-cover" />
                ) : (
                  <SettingsIcon className="size-6" />
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild type="button" variant="outline" size="sm">
                  <label className="cursor-pointer">
                    Загрузить иконку
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      disabled={busy}
                      onChange={(event) => {
                        setIconFile(event.target.files?.[0] ?? null)
                        setRemoveIcon(false)
                      }}
                    />
                  </label>
                </Button>
                {channel.icon || iconFile ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setIconFile(null)
                      setRemoveIcon(true)
                    }}
                  >
                    Удалить иконку
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-settings-name">Название</Label>
              <Input
                id="group-settings-name"
                value={name}
                maxLength={32}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-settings-description">Описание</Label>
              <Textarea
                id="group-settings-description"
                value={description}
                maxLength={1024}
                disabled={busy}
                className="min-h-20 resize-y"
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <Button type="button" disabled={busy} onClick={() => void saveProfile()}>
              Сохранить профиль
            </Button>
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Участники</h3>
              <span className="text-xs text-muted-foreground">
                {loadingMembers ? 'Загрузка…' : members.length}
              </span>
            </div>
            <div className="space-y-1">
              {members.map((member) => (
                <div key={member._id} className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-muted/40">
                  <UserAvatar user={member} className="size-8" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {member.display_name ?? member.username}
                    {member._id === channel.owner ? (
                      <span className="ml-2 text-xs text-muted-foreground">владелец</span>
                    ) : null}
                  </span>
                  {isOwner && member._id !== currentUserId ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void transferOwnership(member)}
                      >
                        Передать
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Удалить участника"
                        disabled={busy}
                        onClick={() => void removeMember(member)}
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
                <p className="text-xs font-semibold text-muted-foreground">Добавить друга</p>
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
                      Добавить
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
              onClick={() => void leaveGroup()}
            >
              <LogOutIcon className="size-4" />
              Выйти из группы
            </Button>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
