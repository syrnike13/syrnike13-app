import { useTranslations } from '@syrnike13/ui/i18n'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Channel, Webhook } from '@syrnike13/api-types'
import { Effect, Fiber } from 'effect'
import {
  CheckIcon,
  CopyIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from '#/components/icons'
import { toast } from 'sonner'

import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { useAuth } from '#/features/auth/auth-context'
import {
  createChannelWebhookEffect,
  deleteWebhookEffect,
  editWebhookEffect,
  fetchChannelWebhooksEffect,
} from '#/features/api/channels-api'
import { writeClipboardTextEffect } from '#/lib/clipboard'
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
  const t = useTranslations('channels.webhooks')
  const auth = useAuth()
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [webhookPendingDeletion, setWebhookPendingDeletion] =
    useState<Webhook | null>(null)
  const token = auth.session?.token

  useEffect(() => {
    if (!token) return
    const sessionToken = token

    setLoading(true)
    const fiber = Effect.runFork(
      fetchChannelWebhooksEffect(sessionToken, channel._id).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : t('loadError'),
              )
              setLoading(false)
            }),
          onSuccess: (nextWebhooks) =>
            Effect.sync(() => {
              setWebhooks(nextWebhooks)
              setLoading(false)
            }),
        }),
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
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
      toast.error(t('nameRequired'))
      return
    }

    setCreating(true)
    await Effect.runPromise(
      createChannelWebhookEffect(token, channel._id, {
        name: trimmedName,
      }).pipe(
        Effect.tap((webhook) =>
          Effect.sync(() => {
            setWebhooks((current) => [webhook, ...current])
            setName('')
            toast.success(t('created'))
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error ? error.message : t('createError'),
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setCreating(false))),
      ),
    )
  }

  async function deleteSelectedWebhook() {
    const webhook = webhookPendingDeletion
    if (!token || !webhook) return

    setDeletingId(webhook.id)
    await Effect.runPromise(
      deleteWebhookEffect(token, webhook.id).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setWebhooks((current) =>
              current.filter(
                (currentWebhook) => currentWebhook.id !== webhook.id,
              ),
            )
            setWebhookPendingDeletion(null)
            toast.success(t('deleted'))
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error ? error.message : t('deleteError'),
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setDeletingId(null))),
      ),
    )
  }

  function beginRename(webhook: Webhook) {
    setEditingId(webhook.id)
    setEditingName(webhook.name)
  }

  function cancelRename() {
    setEditingId(null)
    setEditingName('')
  }

  async function saveWebhookName(
    webhook: Webhook,
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    const trimmedName = editingName.trim()
    if (!token || !trimmedName) {
      toast.error(t('nameRequired'))
      return
    }

    if (trimmedName === webhook.name) {
      cancelRename()
      return
    }

    setSavingId(webhook.id)
    await Effect.runPromise(
      editWebhookEffect(token, webhook.id, { name: trimmedName }).pipe(
        Effect.tap((updatedWebhook) =>
          Effect.sync(() => {
            setWebhooks((current) =>
              current.map((currentWebhook) =>
                currentWebhook.id === webhook.id
                  ? {
                      ...currentWebhook,
                      ...updatedWebhook,
                      token: updatedWebhook.token ?? currentWebhook.token,
                    }
                  : currentWebhook,
              ),
            )
            cancelRename()
            toast.success(t('updated'))
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : t('updateError'),
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setSavingId(null))),
      ),
    )
  }

  async function copyWebhookUrl(webhook: Webhook) {
    const url = buildWebhookUrl(webhook)
    if (!url) return

    await Effect.runPromise(
      writeClipboardTextEffect(url).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : t('copyError'),
              )
            }),
          onSuccess: () =>
            Effect.sync(() => toast.success(t('copied'))),
        }),
      ),
    )
  }

  return (
    <>
      <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">#{channel.name}</p>
      </div>

      <section className="border-b border-border/60 py-6">
        <div className="mb-4">
          <h3 className="text-base font-semibold">{t('createTitle')}</h3>
        </div>
        <form className="flex flex-col gap-3 sm:flex-row" onSubmit={createWebhook}>
          <div className="min-w-0 flex-1">
            <Label htmlFor="channel-webhook-name" className="sr-only">
              {t('nameLabel')}
            </Label>
            <Input
              id="channel-webhook-name"
              value={name}
              maxLength={32}
              placeholder={t('namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={creating || !name.trim()}>
            <PlusIcon className="size-4" />
            {t('createSubmit')}
          </Button>
        </form>
      </section>

      <section className="py-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold">{t('title')}</h3>
          <span className="text-xs font-medium text-muted-foreground">
            {sortedWebhooks.length}
          </span>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : sortedWebhooks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('empty')}
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
                    {editingId === webhook.id ? (
                      <form
                        className="flex min-w-0 flex-1 items-center gap-2"
                        onSubmit={(event) =>
                          void saveWebhookName(webhook, event)
                        }
                      >
                        <div className="min-w-0 flex-1">
                          <Label
                            htmlFor={`channel-webhook-edit-${webhook.id}`}
                            className="sr-only"
                          >
                            {t('newName')}
                          </Label>
                          <Input
                            id={`channel-webhook-edit-${webhook.id}`}
                            aria-label={t('newName')}
                            value={editingName}
                            maxLength={32}
                            onChange={(event) =>
                              setEditingName(event.target.value)
                            }
                          />
                        </div>
                        <Button
                          type="submit"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('saveAria', { name: webhook.name })}
                          disabled={savingId === webhook.id || !editingName.trim()}
                        >
                          <CheckIcon className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('cancelAria', { name: webhook.name })}
                          disabled={savingId === webhook.id}
                          onClick={cancelRename}
                        >
                          <XIcon className="size-4" />
                        </Button>
                      </form>
                    ) : (
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {webhook.name}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {webhook.id}
                        </p>
                      </div>
                    )}
                    <div className="flex shrink-0 items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('renameAria', { name: webhook.name })}
                            disabled={
                              editingId === webhook.id ||
                              deletingId === webhook.id ||
                              savingId === webhook.id
                            }
                            onClick={() => beginRename(webhook)}
                          >
                            <PencilIcon className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={6}>
                          {t('rename')}
                        </TooltipContent>
                      </Tooltip>
                      {url ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('copyUrlAria', { name: webhook.name })}
                              onClick={() => void copyWebhookUrl(webhook)}
                            >
                              <CopyIcon className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" sideOffset={6}>
                            {t('copyUrl')}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('deleteAria', { name: webhook.name })}
                            disabled={
                              deletingId === webhook.id ||
                              savingId === webhook.id
                            }
                            onClick={() => setWebhookPendingDeletion(webhook)}
                          >
                            <Trash2Icon className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={6}>
                          {t('delete')}
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
      <Dialog
        open={webhookPendingDeletion !== null}
        onOpenChange={(open) => {
          if (!open && !deletingId) {
            setWebhookPendingDeletion(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('deleteTitle', { name: webhookPendingDeletion?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {t('deleteDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deletingId !== null}
              onClick={() => setWebhookPendingDeletion(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deletingId !== null}
              onClick={() => void deleteSelectedWebhook()}
            >
              {t('deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
