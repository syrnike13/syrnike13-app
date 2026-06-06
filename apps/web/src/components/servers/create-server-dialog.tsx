import { useState, type ReactNode } from 'react'
import { PlusIcon } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import {
  railIconButtonClass,
  railIconIdleClass,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { useAuth } from '#/features/auth/auth-context'
import { isServerInviteJoin, joinInvite } from '#/features/api/invites-api'
import { createServer } from '#/features/api/servers-api'
import { syncStore } from '#/features/sync/sync-store'
import { parseInviteCode } from '#/lib/invite-link'

type CreateServerDialogProps = {
  trigger?: ReactNode
}

type DialogMode = 'create' | 'join'

function resetDialogState(setters: {
  setName: (value: string) => void
  setInviteInput: (value: string) => void
  setMode: (value: DialogMode) => void
}) {
  setters.setName('')
  setters.setInviteInput('')
  setters.setMode('create')
}

export function CreateServerDialog({ trigger }: CreateServerDialogProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<DialogMode>('create')
  const [name, setName] = useState('')
  const [inviteInput, setInviteInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [joining, setJoining] = useState(false)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      resetDialogState({ setName, setInviteInput, setMode })
    }
  }

  async function submitCreate() {
    const token = auth.session?.token
    const trimmed = name.trim()
    if (!token || !trimmed) return

    setSaving(true)
    try {
      const { server, channels } = await createServer(token, { name: trimmed })
      syncStore.upsertServer(server)
      for (const channel of channels) {
        syncStore.upsertChannel(channel)
      }
      syncStore.setSelectedServerId(server._id)
      handleOpenChange(false)
      toast.success(`Сервер «${server.name}» создан`)

      const firstChannel = channels[0]
      if (firstChannel) {
        await navigate({
          to: '/app/c/$channelId',
          params: { channelId: firstChannel._id },
        })
      } else {
        await navigate({ to: '/app' })
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать сервер',
      )
    } finally {
      setSaving(false)
    }
  }

  async function submitJoin() {
    const token = auth.session?.token
    const code = parseInviteCode(inviteInput)
    if (!token) return
    if (!code) {
      toast.error('Вставьте ссылку приглашения или код')
      return
    }

    setJoining(true)
    try {
      const response = await joinInvite(token, code)
      if (isServerInviteJoin(response)) {
        syncStore.upsertServer(response.server)
        for (const channel of response.channels) {
          syncStore.upsertChannel(channel)
        }
        syncStore.setSelectedServerId(response.server._id)
        handleOpenChange(false)
        toast.success('Вы присоединились к серверу')

        const channel = response.channels[0]
        if (channel) {
          await navigate({
            to: '/app/c/$channelId',
            params: { channelId: channel._id },
          })
        } else {
          await navigate({ to: '/app' })
        }
        return
      }

      handleOpenChange(false)
      toast.success('Приглашение принято')
      await navigate({ to: '/app' })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось присоединиться',
      )
    } finally {
      setJoining(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(railIconButtonClass, railIconIdleClass)}
            title="Создать сервер"
          >
            <PlusIcon />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        {mode === 'create' ? (
          <>
            <DialogHeader>
              <DialogTitle>Создать сервер</DialogTitle>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                void submitCreate()
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="server-name">Название</Label>
                <Input
                  id="server-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Мой сервер"
                  autoFocus
                />
              </div>
              <Button type="submit" disabled={saving || !name.trim()}>
                Создать
              </Button>
            </form>

            <div className="-mx-6 -mb-6 mt-2 flex flex-col gap-3 border-t border-border bg-muted/40 px-6 py-4">
              <p className="text-center text-sm text-secondary-foreground">
                Вас уже пригласили?
              </p>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() => setMode('join')}
              >
                Зайти на сервер
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Зайти на сервер</DialogTitle>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                void submitJoin()
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="server-invite">Ссылка или код приглашения</Label>
                <Input
                  id="server-invite"
                  value={inviteInput}
                  onChange={(event) => setInviteInput(event.target.value)}
                  placeholder="https://syrnike13.ru/invite/…"
                  autoFocus
                />
              </div>
              <Button
                type="submit"
                disabled={joining || !inviteInput.trim()}
              >
                Присоединиться
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setMode('create')}
              >
                Назад
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
