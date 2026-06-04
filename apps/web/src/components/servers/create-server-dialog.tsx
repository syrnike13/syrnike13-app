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
import { createServer } from '#/features/api/servers-api'
import { syncStore } from '#/features/sync/sync-store'

type CreateServerDialogProps = {
  trigger?: ReactNode
}

export function CreateServerDialog({ trigger }: CreateServerDialogProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
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
      setOpen(false)
      setName('')
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
        <DialogHeader>
          <DialogTitle>Создать сервер</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
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
      </DialogContent>
    </Dialog>
  )
}
