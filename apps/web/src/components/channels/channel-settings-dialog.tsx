import { useEffect, useState } from 'react'
import type { Channel } from '@syrnike13/api-types'
import { SettingsIcon, Trash2Icon } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

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
import { useAuth } from '#/features/auth/auth-context'
import {
  deleteChannel,
  editChannel,
} from '#/features/api/channels-api'
import { getChannelDescription } from '#/lib/channel-meta'
import { pickDefaultChannelId } from '#/features/sync/selectors'
import { syncStore } from '#/features/sync/sync-store'

type ServerChannel = Extract<
  Channel,
  { channel_type: 'TextChannel' | 'VoiceChannel' }
>

type ChannelSettingsDialogProps = {
  channel: ServerChannel
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function ChannelSettingsDialog({
  channel,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: ChannelSettingsDialogProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = controlledOnOpenChange ?? setInternalOpen
  const [name, setName] = useState(channel.name)
  const [description, setDescription] = useState(
    getChannelDescription(channel) ?? '',
  )
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (open) {
      setName(channel.name)
      setDescription(getChannelDescription(channel) ?? '')
    }
  }, [channel, open])

  async function saveSettings() {
    const token = auth.session?.token
    const trimmedName = name.trim()
    const trimmedDescription = description.trim()
    if (!token || !trimmedName) return

    const currentDescription = getChannelDescription(channel) ?? ''
    const nameChanged = trimmedName !== channel.name
    const descriptionChanged = trimmedDescription !== currentDescription

    if (!nameChanged && !descriptionChanged) {
      setOpen(false)
      return
    }

    setSaving(true)
    try {
      const updated = await editChannel(token, channel._id, {
        ...(nameChanged ? { name: trimmedName } : {}),
        ...(descriptionChanged
          ? { description: trimmedDescription || null }
          : {}),
      })
      syncStore.patchChannel(channel._id, updated)
      toast.success('Канал обновлён')
      setOpen(false)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось сохранить',
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    const token = auth.session?.token
    if (!token) return
    if (
      !window.confirm(
        `Удалить канал «${channel.name}»? Это действие необратимо.`,
      )
    ) {
      return
    }

    setDeleting(true)
    try {
      await deleteChannel(token, channel._id)
      syncStore.removeChannel(channel._id)
      setOpen(false)
      toast.success('Канал удалён')

      const fallback = pickDefaultChannelId(
        syncStore.getState(),
        auth.user?._id,
      )
      if (fallback) {
        await navigate({
          to: '/app/c/$channelId',
          params: { channelId: fallback },
          search: { m: undefined },
        })
      } else {
        await navigate({ to: '/app', search: { tab: 'online' } })
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось удалить канал',
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlledOpen === undefined ? (
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            title="Настройки канала"
          >
            <SettingsIcon className="size-4" />
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Канал #{channel.name}</DialogTitle>
          <DialogDescription>Название, описание и удаление</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void saveSettings()
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-rename">Название</Label>
            <Input
              id="channel-rename"
              value={name}
              maxLength={32}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {channel.channel_type === 'TextChannel' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="channel-description">Описание</Label>
              <Textarea
                id="channel-description"
                value={description}
                rows={3}
                maxLength={1024}
                placeholder="О чём этот канал"
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          ) : null}
          <Button type="submit" disabled={saving || !name.trim()}>
            Сохранить
          </Button>
        </form>
        <Button
          type="button"
          variant="destructive"
          disabled={deleting}
          onClick={() => void handleDelete()}
        >
          <Trash2Icon className="size-4" />
          Удалить канал
        </Button>
      </DialogContent>
    </Dialog>
  )
}
