import { useNavigate } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { MessageCircleIcon, PlusIcon, UsersIcon } from '#/components/icons'
import { useMemo, useState } from 'react'

import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from '@syrnike13/ui/primitives/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import { Separator } from '@syrnike13/ui/primitives/separator'
import { useAuth } from '#/features/auth/auth-context'
import { createGroupChannelEffect } from '@syrnike13/client/api/channels-api'
import { openDirectMessageChannel } from '#/features/dm/dm-actions'
import { listUsersByRelationship } from '@syrnike13/client/sync/selectors'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'

type DialogMode = 'dm' | 'group' | null

export function NewConversationButton() {
  const t = useTranslations('home.newConversation')
  const auth = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState<DialogMode>(null)
  const [filter, setFilter] = useState('')
  const [groupName, setGroupName] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const friends = useSyncStore((s) =>
    listUsersByRelationship(s, 'Friend', auth.user?._id).filter(
      (user) => !user.bot,
    ),
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
      await Effect.runPromise(
        openDirectMessageChannel(token, userId, (channelId) => {
          closeDialog()
          return navigate({
            to: '/c/$channelId',
            params: { channelId },
            search: { m: undefined },
          })
        }),
      )
    } catch {
      // dm-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  async function createGroup() {
    const token = auth.session?.token
    const trimmed = groupName.trim()
    if (!token || !trimmed) return

    setBusy(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        const channel = yield* createGroupChannelEffect(
          token,
          trimmed,
          selectedIds,
        )
        yield* Effect.sync(() => {
          syncStore.upsertChannel(channel)
          syncStore.setSelectedServerId(null)
          closeDialog()
        })
        yield* Effect.tryPromise({
          try: () =>
            navigate({
              to: '/c/$channelId',
              params: { channelId: channel._id },
              search: { m: undefined },
            }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    )
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              title={t('title')}
            />
          }
        >
          <PlusIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={() => openDialog('dm')}>
            <MessageCircleIcon />
            {t('directMessage')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openDialog('group')}>
            <UsersIcon />
            {t('group')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={mode === 'dm'} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="gap-0 p-0 sm:max-w-md">
          <DialogHeader className="px-4 py-3">
            <DialogTitle>{t('directMessage')}</DialogTitle>
            <DialogDescription>{t('selectFriend')}</DialogDescription>
          </DialogHeader>
          <Separator />
          <Command shouldFilter={false}>
            <CommandInput
              value={filter}
              onValueChange={setFilter}
              placeholder={t('searchByName')}
            />
            <CommandList className="max-h-72">
              {filteredFriends.length === 0 ? (
                <Empty size="sm">
                  <EmptyDescription>{t('noFriends')}</EmptyDescription>
                </Empty>
              ) : (
                filteredFriends.map((user) => (
                  <CommandItem
                    key={user._id}
                    value={user._id}
                    disabled={busy}
                    onSelect={() => void startDm(user._id)}
                  >
                    <UserAvatar user={user} className="size-8" />
                    <span className="min-w-0 truncate font-medium">
                      {user.display_name ?? user.username}
                    </span>
                  </CommandItem>
                ))
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mode === 'group'}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent className="gap-0 p-0 sm:max-w-md">
          <DialogHeader className="px-4 py-3">
            <DialogTitle>{t('groupTitle')}</DialogTitle>
            <DialogDescription>
              {t('groupDescription')}
            </DialogDescription>
          </DialogHeader>
          <Separator />
          <div className="space-y-3 px-4 py-3">
            <div className="space-y-1.5">
              <Label htmlFor="group-name">{t('name')}</Label>
              <Input
                id="group-name"
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder={t('groupNamePlaceholder')}
              />
            </div>
          </div>
          <Command shouldFilter={false}>
            <CommandInput
              value={filter}
              onValueChange={setFilter}
              placeholder={t('searchFriends')}
            />
            <CommandList className="max-h-52">
              {filteredFriends.length === 0 ? (
                <Empty size="sm">
                  <EmptyDescription>{t('noFriendsToAdd')}</EmptyDescription>
                </Empty>
              ) : (
                filteredFriends.map((user) => {
                  const selected = selectedIds.includes(user._id)
                  return (
                    <CommandItem
                      key={user._id}
                      value={user._id}
                      data-checked={selected}
                      disabled={busy}
                      onSelect={() => toggleMember(user._id)}
                    >
                      <UserAvatar user={user} className="size-8" />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {user.display_name ?? user.username}
                      </span>
                    </CommandItem>
                  )
                })
              )}
            </CommandList>
          </Command>
          <div className="flex justify-end gap-2 border-t px-4 py-3">
            <Button type="button" variant="ghost" onClick={closeDialog}>
              {t('cancel')}
            </Button>
            <Button
              type="button"
              disabled={busy || !groupName.trim()}
              onClick={() => void createGroup()}
            >
              {t('create')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
