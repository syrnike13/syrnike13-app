import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Channel, Webhook } from '@syrnike13/api-types'
import { CopyIcon, LinkIcon, PlusIcon, Trash2Icon } from '#/components/icons'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { useAuth } from '#/features/auth/auth-context'
import {
  createChannelWebhook,
  deleteWebhook,
  fetchChannelWebhooks,
} from '#/features/api/channels-api'
import { writeClipboardText } from '#/lib/clipboard'
import { config } from '#/lib/config'

type TextChannel = Extract<Channel, { channel_type: 'TextChannel' }>

function buildWebhookUrl(webhook: Webhook) {
  if (!webhook.token) return null
  return `${config.apiUrl.replace(/\/$/, '')}/webhooks/${webhook.id}/${webhook.token}`
}

export function ChannelSettingsWebhooksPanel({
  channel,
}: {
  channel: TextChannel
}) {
  const auth = useAuth()
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const token = auth.session?.token

  useEffect(() => {
    if (!token) return
    let active = true

    async function loadWebhooks() {
      setLoading(true)
      try {
        const nextWebhooks = await fetchChannelWebhooks(token, channel._id)
        if (active) setWebhooks(nextWebhooks)
      } catch (error) {
        if (active) {
          toast.error(
            error instanceof Error
              ? error.message
              : 'Не удалось загрузить вебхуки',
          )
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    void loadWebhooks()

    return () => {
      active = false
    }
  }, [channel._id, token])

  const sortedWebhooks = useMemo(
    () => [...webhooks].sort((a, b) => a.name.localeCompare(b.name)),
    [webhooks],
  )

  async function createWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedName = name.trim()
    if (!token || !trimmedName) {
      toast.error('Укажите название вебхука')
      return
    }

    setCreating(true)
    try {
      const webhook = await createChannelWebhook(token, channel._id, {
        name: trimmedName,
      })
      setWebhooks((current) => [webhook, ...current])
      setName('')
      toast.success('Вебхук создан')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать вебхук',
      )
    } finally {
      setCreating(false)
    }
  }

  async function deleteSelectedWebhook(webhook: Webhook) {
    if (!token) return
    if (!window.confirm(`Удалить вебхук «${webhook.name}»?`)) return

    setDeletingId(webhook.id)
    try {
      await deleteWebhook(token, webhook.id)
      setWebhooks((current) =>
        current.filter((currentWebhook) => currentWebhook.id !== webhook.id),
      )
      toast.success('Вебхук удалён')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось удалить вебхук',
      )
    } finally {
      setDeletingId(null)
    }
  }

  async function copyWebhookUrl(webhook: Webhook) {
    const url = buildWebhookUrl(webhook)
    if (!url) return

    try {
      await writeClipboardText(url)
      toast.success('URL вебхука скопирован')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось скопировать URL',
      )
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Вебхуки</h2>
        <p className="mt-1 text-sm text-muted-foreground">#{channel.name}</p>
      </div>

      <section className="border-b border-border/60 py-6">
        <div className="mb-4">
          <h3 className="text-base font-semibold">Создать вебхук</h3>
        </div>
        <form className="flex flex-col gap-3 sm:flex-row" onSubmit={createWebhook}>
          <div className="min-w-0 flex-1">
            <Label htmlFor="channel-webhook-name" className="sr-only">
              Название вебхука
            </Label>
            <Input
              id="channel-webhook-name"
              value={name}
              maxLength={32}
              placeholder="Название вебхука"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={creating || !name.trim()}>
            <PlusIcon className="size-4" />
            Создать вебхук
          </Button>
        </form>
      </section>

      <section className="py-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold">Вебхуки</h3>
          <span className="text-xs font-medium text-muted-foreground">
            {sortedWebhooks.length}
          </span>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Загрузка...</p>
        ) : sortedWebhooks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            В этом канале нет вебхуков.
          </p>
        ) : (
          <TooltipProvider delayDuration={300}>
            <div className="flex flex-col gap-2">
              {sortedWebhooks.map((webhook) => {
                const url = buildWebhookUrl(webhook)
                return (
                  <div
                    key={webhook.id}
                    className="flex min-w-0 items-center gap-3 rounded-md border border-border/70 bg-muted/20 p-3"
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <LinkIcon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {webhook.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {webhook.id}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {url ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Копировать URL ${webhook.name}`}
                              onClick={() => void copyWebhookUrl(webhook)}
                            >
                              <CopyIcon className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" sideOffset={6}>
                            Копировать URL
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Удалить ${webhook.name}`}
                            disabled={deletingId === webhook.id}
                            onClick={() => void deleteSelectedWebhook(webhook)}
                          >
                            <Trash2Icon className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={6}>
                          Удалить
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                )
              })}
            </div>
          </TooltipProvider>
        )}
      </section>
    </div>
  )
}
