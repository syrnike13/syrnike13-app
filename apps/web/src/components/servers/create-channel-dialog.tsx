import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Option, Schema } from 'effect'
import { useState } from 'react'
import { HashIcon, Volume2BoldIcon } from '#/components/icons'
import { useNavigate } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'

import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@syrnike13/ui/primitives/select'
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
  const t = useTranslations('servers.channels')
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
              Effect.catch(() =>
                Effect.sync(() => {
                }),
              ),
            )
          }
        }

        yield* Effect.sync(() => {
          onOpenChange(false)
          setName('')
          setType('Text')
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
        Effect.catch(() =>
          Effect.sync(() => {
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
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-name">{t('name')}</Label>
            <Input
              id="channel-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('namePlaceholder')}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>{t('type')}</Label>
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
                <SelectValue>
                  <span className="flex items-center gap-2">
                    {type === 'Voice' ? (
                      <Volume2BoldIcon className="size-4" />
                    ) : (
                      <HashIcon className="size-4" />
                    )}
                    {type === 'Voice' ? t('voice') : t('text')}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Text">
                  <span className="flex items-center gap-2">
                    <HashIcon className="size-4" />
                    {t('text')}
                  </span>
                </SelectItem>
                <SelectItem value="Voice">
                  <span className="flex items-center gap-2">
                    <Volume2BoldIcon className="size-4" />
                    {t('voice')}
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={saving || !name.trim()}>
            {t('create')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
