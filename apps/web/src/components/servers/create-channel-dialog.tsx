import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Option, Schema } from 'effect'
import { useState } from 'react'
import { HashIcon, Volume2BoldIcon } from '#/components/icons'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import {
  createServerChannelEffect,
  editServerEffect,
} from '#/features/api/servers-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { syncStore } from '#/features/sync/sync-store'
import { appendChannelToCategory } from '#/lib/channel-sidebar-layout'
import { isServerVoiceChannel, normalizeServerChannel } from '#/lib/channel-voice'

type CreateChannelDialogProps = {
  serverId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  categoryId?: string
}

export function CreateChannelDialog({
  serverId,
  open,
  onOpenChange,
  categoryId,
}: CreateChannelDialogProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const [name, setName] = useState('')
  const [type, setType] = useState<'Text' | 'Voice'>('Text')
  const [saving, setSaving] = useState(false)

  async function submit() {
    const token = auth.session?.token
    const trimmed = name.trim()
    if (!token || !trimmed) return

    setSaving(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        const created = yield* createServerChannelEffect(token, serverId, {
          name: trimmed,
          type,
        })
        const channel = normalizeServerChannel(created, type)
        yield* Effect.sync(() => {
          syncStore.upsertChannel(channel)
        })

        if (categoryId) {
          const server = syncStore.getState().servers[serverId]
          if (server) {
            const isVoice = type === 'Voice'
            const isVoiceId = (id: string) => {
              const existing = syncStore.getState().channels[id]
              if (existing) return isServerVoiceChannel(existing)
              return id === channel._id && isVoice
            }
            const categories = appendChannelToCategory(
              server.categories,
              categoryId,
              channel._id,
              { isVoice, isVoiceId },
            )
            yield* editServerEffect(token, serverId, { categories }).pipe(
              Effect.tap((updated) =>
                Effect.sync(() => syncStore.upsertServer(updated)),
              ),
              Effect.catch((error) =>
                Effect.sync(() => {
                  toast.error(
                    error instanceof Error
                      ? `Канал создан, но не удалось добавить в категорию: ${error.message}`
                      : 'Канал создан, но не удалось добавить в категорию',
                  )
                }),
              ),
            )
          }
        }

        yield* Effect.sync(() => {
          onOpenChange(false)
          setName('')
          setType('Text')
          toast.success(`Канал «${trimmed}» создан`)
        })
        yield* Effect.tryPromise({
          try: () =>
            navigate({
              to: `${prefix}/c/$channelId`,
              params: { channelId: channel._id },
              search: { m: undefined },
            }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : 'Не удалось создать канал',
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
              onValueChange={(value) => {
                const decoded = Schema.decodeUnknownOption(
                  ApiSchema.LegacyServerChannelType,
                )(value)
                if (Option.isSome(decoded)) setType(decoded.value)
              }}
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
                    <Volume2BoldIcon className="size-4" />
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
