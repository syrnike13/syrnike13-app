import { useState, type ReactElement } from 'react'
import { Effect } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'
import { PlusIcon } from '#/components/icons'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import {
  railGlyphClass,
  railIconIdleClass,
  railIconSquircleProps,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'
import { Button } from '@syrnike13/ui/primitives/button'
import { Squircle } from '@syrnike13/ui/primitives/squircle'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@syrnike13/ui/primitives/dialog'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import { useAuth } from '#/features/auth/auth-context'
import {
  isGroupInviteJoin,
  isServerInviteJoin,
  joinInviteEffect,
} from '#/features/api/invites-api'
import { createServerEffect } from '#/features/api/servers-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { syncStore } from '#/features/sync/sync-store'
import { parseInviteCode } from '#/lib/invite-link'

type CreateServerDialogProps = {
  trigger?: ReactElement
}

export function CreateServerDialog({ trigger }: CreateServerDialogProps) {
  const t = useTranslations('servers.create')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'create' | 'join'>('create')
  const [name, setName] = useState('')
  const [inviteInput, setInviteInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [joining, setJoining] = useState(false)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setName('')
      setInviteInput('')
      setMode('create')
    }
  }

  async function submitCreate() {
    const token = auth.session?.token
    const trimmed = name.trim()
    if (!token || !trimmed) return

    setSaving(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        const { server, member, channels } = yield* createServerEffect(token, {
          name: trimmed,
        })
        yield* Effect.sync(() => {
          syncStore.applyServerJoinBundle({ server, member, channels })
          syncStore.setSelectedServerId(server._id)
          handleOpenChange(false)
          toast.success(t('created', { name: server.name }))
        })

        const firstChannel = channels[0]
        yield* Effect.tryPromise({
          try: () =>
            firstChannel
              ? navigate({
                  to: `${prefix}/c/$channelId`,
                  params: { channelId: firstChannel._id },
                  search: { m: undefined },
                })
              : navigate({ to: prefix, search: { tab: 'online' } }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : t('createError'),
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    )
  }

  async function submitJoin() {
    const token = auth.session?.token
    const code = parseInviteCode(inviteInput)
    if (!token) return
    if (!code) {
      toast.error(t('inviteRequired'))
      return
    }

    setJoining(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        const response = yield* joinInviteEffect(token, code)
        yield* Effect.sync(() => {
          syncStore.applyInviteJoinResponse(response)
        })
        if (isServerInviteJoin(response)) {
          yield* Effect.sync(() => {
            syncStore.setSelectedServerId(response.server._id)
            handleOpenChange(false)
            toast.success(t('joinSuccess'))
          })

          const channel = response.channels[0]
          yield* Effect.tryPromise({
            try: () =>
              channel
                ? navigate({
                    to: `${prefix}/c/$channelId`,
                    params: { channelId: channel._id },
                    search: { m: undefined },
                  })
                : navigate({ to: prefix, search: { tab: 'online' } }),
            catch: (cause) => cause,
          })
          return
        }

        if (isGroupInviteJoin(response)) {
          yield* Effect.sync(() => {
            handleOpenChange(false)
            toast.success(t('inviteAccepted'))
          })
          yield* Effect.tryPromise({
            try: () =>
              navigate({
                to: `${prefix}/c/$channelId`,
                params: { channelId: response.channel._id },
                search: { m: undefined },
              }),
            catch: (cause) => cause,
          })
          return
        }

        yield* Effect.sync(() =>
          toast.error(t('unknownInvite')),
        )
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : t('joinError'),
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setJoining(false))),
      ),
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          trigger ?? (
            <Squircle asChild {...railIconSquircleProps}>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={cn(
                  'size-11',
                  // eslint-disable-next-line shadcn/require-static-classes -- shared rail idle surface constant
                  railIconIdleClass,
                )}
                title={t('triggerAria')}
              >
                <PlusIcon className={railGlyphClass} />
              </Button>
            </Squircle>
          )
        }
      />
      <DialogContent>
        {mode === 'create' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('title')}</DialogTitle>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                void submitCreate()
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="server-name">{t('name')}</Label>
                <Input
                  id="server-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('namePlaceholder')}
                  autoFocus
                />
              </div>
              <Button type="submit" disabled={saving || !name.trim()}>
                {t('create')}
              </Button>
            </form>

            <div className="-mx-6 -mb-6 mt-2 flex flex-col gap-3 border-t border-border bg-muted/40 px-6 py-4">
              <p className="text-center text-sm text-secondary-foreground">
                {t('invited')}
              </p>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() => setMode('join')}
              >
                {t('joinServer')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('joinTitle')}</DialogTitle>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                void submitJoin()
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="server-invite">{t('inviteLabel')}</Label>
                <Input
                  id="server-invite"
                  value={inviteInput}
                  onChange={(event) => setInviteInput(event.target.value)}
                  placeholder={t('invitePlaceholder')}
                  autoFocus
                />
              </div>
              <Button
                type="submit"
                disabled={joining || !inviteInput.trim()}
              >
                {t('join')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setMode('create')}
              >
                {t('back')}
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
