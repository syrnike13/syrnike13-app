import { useState } from 'react'
import { HashIcon, PlusIcon, Volume2Icon } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { useAuth } from '#/features/auth/auth-context'
import { createServerChannel } from '#/features/api/servers-api'
import { syncStore } from '#/features/sync/sync-store'
import { normalizeServerChannel } from '#/lib/channel-voice'

type CreateChannelDialogProps = {
  serverId: string
}

export function CreateChannelDialog({ serverId }: CreateChannelDialogProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<'Text' | 'Voice'>('Text')
  const [saving, setSaving] = useState(false)

  async function submit() {
    const token = auth.session?.token
    const trimmed = name.trim()
    if (!token || !trimmed) return

    setSaving(true)
    try {
      const created = await createServerChannel(token, serverId, {
        name: trimmed,
        type,
      })
      const channel = normalizeServerChannel(created, type)
      syncStore.upsertChannel(channel)
      setOpen(false)
      setName('')
      setType('Text')
      toast.success(`Канал «${channel.name}» создан`)
      await navigate({
        to: '/app/c/$channelId',
        params: { channelId: channel._id },
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать канал',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          title="Создать канал"
        >
          <PlusIcon className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Создать канал</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-name">Название</Label>
            <Input
              id="channel-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="общий"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Тип</Label>
            <Select
              value={type}
              onValueChange={(value) => setType(value as 'Text' | 'Voice')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Text">
                  <span className="flex items-center gap-2">
                    <HashIcon className="size-4" />
                    Текстовый
                  </span>
                </SelectItem>
                <SelectItem value="Voice">
                  <span className="flex items-center gap-2">
                    <Volume2Icon className="size-4" />
                    Голосовой
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={saving || !name.trim()}>
            Создать
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
