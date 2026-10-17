import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Invite } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { CopyIcon, PlusIcon } from '#/components/icons'
import { toast } from 'sonner'
import {
  useLocale,
  useTranslations,
  type AppLocale,
  type Translator,
} from '@syrnike13/ui/i18n'

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
import { ServerInviteDialog } from '#/components/servers/server-invite-dialog'
import { useAuth } from '#/features/auth/auth-context'
import { fetchServerInvitesEffect } from '#/features/api/servers-api'
import {
  deleteInviteEffect,
  getInviteInactiveReason,
  type InviteInactiveReason,
} from '#/features/api/invites-api'
import { listServerChannels } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { inviteUrl } from '#/lib/invite-link'

type ServerSettingsInvitesPanelProps = {
  serverId: string
}

function formatInviteTimestamp(timestamp: number, locale: AppLocale) {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function formatInviteDate(
  timestamp: number | null | undefined,
  locale: AppLocale,
  t: Translator,
) {
  if (timestamp == null) return t('noExpiry')
  return formatInviteTimestamp(timestamp, locale)
}

function formatInviteUses(invite: Invite) {
  const maxUses = invite.max_uses && invite.max_uses > 0 ? invite.max_uses : '∞'
  return `${invite.uses} / ${maxUses}`
}

const INACTIVE_INVITE_KEYS: Record<InviteInactiveReason, string> = {
  revoked: 'inactive.revoked',
  expired: 'inactive.expired',
  exhausted: 'inactive.exhausted',
}

export function ServerSettingsInvitesPanel({
  serverId,
}: ServerSettingsInvitesPanelProps) {
  const t = useTranslations('servers.invites')
  const { locale } = useLocale()
  const auth = useAuth()
  const token = auth.session?.token
  const channels = useSyncStore((s) =>
    listServerChannels(s, serverId, auth.user?._id),
  )
  const users = useSyncStore((s) => s.users)
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false)
  const [revokingCode, setRevokingCode] = useState<string | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const [invitePendingRevocation, setInvitePendingRevocation] =
    useState<string | null>(null)

  const invitesQuery = useQuery({
    queryKey: ['server-invites', serverId],
    enabled: Boolean(token),
    queryFn: ({ signal }) =>
      Effect.runPromise(
        token
          ? fetchServerInvitesEffect(token, serverId)
          : Effect.fail(new Error(t('noSession'))),
        { signal },
      ),
  })

  const invites = invitesQuery.data ?? []
  const channelNamesById = new Map(
    channels.map((channel) => [channel._id, channel.name]),
  )

  async function revokeInvite() {
    if (!token || !invitePendingRevocation) return

    const code = invitePendingRevocation
    const body = revokeReason.trim() ? { reason: revokeReason.trim() } : {}

    setRevokingCode(code)
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* deleteInviteEffect(token, code, body)
        yield* Effect.tryPromise({
          try: () => invitesQuery.refetch(),
          catch: (cause) => cause,
        })
        yield* Effect.sync(() => {
          setInvitePendingRevocation(null)
          setRevokeReason('')
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : t('revokeError'),
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setRevokingCode(null))),
      ),
    )
  }

  async function copyInvite(code: string) {
    await Effect.runPromise(
      writeClipboardTextEffect(inviteUrl(code)).pipe(
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
    <div className="space-y-6">
      <section className="flex flex-col gap-3 border-b border-border/60 pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-base font-semibold">{t('title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('description')}
          </p>
        </div>
        <Button
          type="button"
          className="w-fit"
          onClick={() => setInviteDialogOpen(true)}
        >
          <PlusIcon className="size-4" />
          {t('create')}
        </Button>
      </section>

      {invitesQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : invitesQuery.error ? (
        <p className="text-sm text-destructive">{t('loadError')}</p>
      ) : invites.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {invites.map((invite) => {
            const inactiveReason = getInviteInactiveReason(invite)
            const inactiveLabel = inactiveReason
              ? t(INACTIVE_INVITE_KEYS[inactiveReason])
              : null
            const revoked = inactiveReason === 'revoked'
            const inactive = inactiveReason !== null
            const channelLabel = `#${
              channelNamesById.get(invite.channel) ?? invite.channel
            }`
            const creator = users[invite.creator]
            const creatorLabel =
              creator?.display_name || creator?.username || invite.creator
            const revoker = invite.revoked_by
              ? users[invite.revoked_by]
              : undefined
            const revokerLabel =
              revoker?.display_name ||
              revoker?.username ||
              invite.revoked_by ||
              t('unknown')

            return (
              <li
                key={invite._id}
                className="flex flex-col gap-3 rounded-md border border-border px-3 py-2.5 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">
                      {invite._id}
                    </p>
                    {inactiveLabel ? (
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {inactiveLabel}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {channelLabel} · {t('uses', { value: formatInviteUses(invite) })} ·{' '}
                    {t('expires', {
                      date: formatInviteDate(invite.expires_at, locale, t),
                    })}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('createdBy', {
                      name: creatorLabel,
                      date: formatInviteTimestamp(invite.created_at, locale),
                    })}
                  </p>
                  {invite.revoked_at ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('revokedBy', {
                        name: revokerLabel,
                        date: formatInviteTimestamp(invite.revoked_at, locale),
                      })}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('copyAria', { code: invite._id })}
                    disabled={inactive}
                    onClick={() => void copyInvite(invite._id)}
                  >
                    <CopyIcon className="size-3.5" />
                    {t('copy')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={revoked || revokingCode === invite._id}
                    onClick={() => setInvitePendingRevocation(invite._id)}
                  >
                    {t('revoke')}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Dialog
        open={invitePendingRevocation !== null}
        onOpenChange={(open) => {
          if (!open && revokingCode === null) {
            setInvitePendingRevocation(null)
            setRevokeReason('')
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('revokeTitle', { code: invitePendingRevocation ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('revokeDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label htmlFor="invite-revoke-reason">{t('revokeReasonLabel')}</Label>
            <Input
              id="invite-revoke-reason"
              value={revokeReason}
              maxLength={512}
              disabled={revokingCode !== null}
              onChange={(event) => setRevokeReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={revokingCode !== null}
              onClick={() => {
                setInvitePendingRevocation(null)
                setRevokeReason('')
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={revokingCode !== null}
              onClick={() => void revokeInvite()}
            >
              {t('revokeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ServerInviteDialog
        serverId={serverId}
        open={inviteDialogOpen}
        onOpenChange={(open) => {
          setInviteDialogOpen(open)
          if (!open) void invitesQuery.refetch()
        }}
      />
    </div>
  )
}
