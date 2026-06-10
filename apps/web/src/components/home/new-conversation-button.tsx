import { useNavigate } from '@tanstack/react-router'
import { MessageCircleIcon, PlusIcon, UsersIcon } from '#/components/icons'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { createGroupChannel } from '#/features/api/channels-api'
import { openDirectMessage } from '#/features/api/users-api'
import { listUsersByRelationship } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

type DialogMode = 'dm' | 'group' | null

export function NewConversationButton() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState<DialogMode>(null)
  const [filter, setFilter] = useState('')
  const [groupName, setGroupName] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const friends = useSyncStore((s) =>
    listUsersByRelationship(s, 'Friend', auth.user?._id),
  )

  const filteredFriends = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return friends
    return friends.filter((user) => {
      const label = (user.display_name ?? user.username).toLowerCase()
      return label.includes(q) || user.username.toLowerCase().includes(q)
    })
  }, [filter, friends])

  function openDialog(next: DialogMode) {
    setMenuOpen(false)
    setMode(next)
    setFilter('')
    setGroupName('')
    setSelectedIds([])
  }

  function closeDialog() {
    setMode(null)
    setFilter('')
    setGroupName('')
    setSelectedIds([])
  }

  function toggleMember(userId: string) {
    setSelectedIds((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId],
    )
  }

  async function startDm(userId: string) {
    const token = auth.session?.token
    if (!token) return

    setBusy(true)
    try {
      const channel = await openDirectMessage(token, userId)
      syncStore.upsertChannel(channel)
      syncStore.setSelectedServerId(null)
      closeDialog()
      await navigate({
        to: '/app/c/$channelId',
        params: { channelId: channel._id },
        search: {},
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось открыть ЛС',
      )
    } finally {
      setBusy(false)
    }
  }

  async function createGroup() {
    const token = auth.session?.token
    const trimmed = groupName.trim()
    if (!token || !trimmed) return

    setBusy(true)
    try {
      const channel = await createGroupChannel(token, trimmed, selectedIds)
      syncStore.upsertChannel(channel)
      syncStore.setSelectedServerId(null)
      closeDialog()
      toast.success('Группа создана')
      await navigate({
        to: '/app/c/$channelId',
        params: { channelId: channel._id },
        search: {},
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать группу',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            title="Новая беседа"
          >
            <PlusIcon className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-52 p-1">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent"
            onClick={() => openDialog('dm')}
          >
            <MessageCircleIcon className="size-4 shrink-0" />
            Личное сообщение
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent"
            onClick={() => openDialog('group')}
          >
            <UsersIcon className="size-4 shrink-0" />
            Группа
          </button>
        </PopoverContent>
      </Popover>

      <Dialog open={mode === 'dm'} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="gap-0 p-0 sm:max-w-md">
          <DialogHeader className="border-b px-4 py-3">
            <DialogTitle>Личное сообщение</DialogTitle>
            <DialogDescription>Выберите друга</DialogDescription>
          </DialogHeader>
          <div className="px-4 py-3">
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Поиск по имени"
              className="h-9"
            />
          </div>
          <ScrollArea className="max-h-72 px-2 pb-3">
            {filteredFriends.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                Нет друзей
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {filteredFriends.map((user) => (
                  <li key={user._id}>
                    <button
                      type="button"
                      disabled={busy}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
                      onClick={() => void startDm(user._id)}
                    >
                      <UserAvatar user={user} className="size-8" />
                      <span className="min-w-0 truncate font-medium">
                        {user.display_name ?? user.username}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mode === 'group'}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent className="gap-0 p-0 sm:max-w-md">
          <DialogHeader className="border-b px-4 py-3">
            <DialogTitle>Новая группа</DialogTitle>
            <DialogDescription>
              Название и участники (можно добавить позже)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-4 py-3">
            <div className="space-y-1.5">
              <Label htmlFor="group-name">Название</Label>
              <Input
                id="group-name"
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder="Название группы"
                className="h-9"
              />
            </div>
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Поиск друзей"
              className="h-9"
            />
          </div>
          <ScrollArea className="max-h-52 px-2">
            {filteredFriends.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                Нет друзей для добавления
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {filteredFriends.map((user) => {
                  const selected = selectedIds.includes(user._id)
                  return (
                    <li key={user._id}>
                      <button
                        type="button"
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent',
                          selected && 'bg-accent',
                        )}
                        onClick={() => toggleMember(user._id)}
                      >
                        <UserAvatar user={user} className="size-8" />
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {user.display_name ?? user.username}
                        </span>
                        {selected ? (
                          <span className="text-xs text-primary">✓</span>
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </ScrollArea>
          <div className="flex justify-end gap-2 border-t px-4 py-3">
            <Button type="button" variant="ghost" onClick={closeDialog}>
              Отмена
            </Button>
            <Button
              type="button"
              disabled={busy || !groupName.trim()}
              onClick={() => void createGroup()}
            >
              Создать
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
