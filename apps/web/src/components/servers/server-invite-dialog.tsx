import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DataCreateInvite, Invite, User } from '@syrnike13/api-types'
import { Effect, Fiber } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  HashIcon,
  SearchIcon,
} from '#/components/icons'

import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'
import { Label } from '@syrnike13/ui/primitives/label'
import {
  NativeSelect,
  NativeSelectOption,
} from '@syrnike13/ui/primitives/native-select'
import { UserAvatar } from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import { sendChannelMessageEffect } from '@syrnike13/client/api/messages-api'
import { fetchServerInvitesEffect } from '@syrnike13/client/api/servers-api'
import { openDirectMessageEffect } from '@syrnike13/client/api/users-api'
import {
  createChannelInviteEffect,
  getInviteInactiveReason,
} from '@syrnike13/client/api/invites-api'
import {
  listServerChannels,
  listUsersByRelationship,
} from '@syrnike13/client/sync/selectors'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import {
  canInviteToChannel,
  canManageServer,
} from '#/features/authorization/authorization'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { inviteUrl } from '#/lib/invite-link'
import { cn } from '#/lib/utils'

type ServerInviteDialogProps = {
  serverId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const INVITE_MAX_AGE_OPTIONS = [
  { labelKey: 'maxAge.oneHour', value: '3600' },
  { labelKey: 'maxAge.oneDay', value: '86400' },
  { labelKey: 'maxAge.sevenDays', value: '604800' },
  { labelKey: 'maxAge.never', value: '0' },
]

type InviteMaxUsesOption =
  | { value: string; labelKey: string }
  | { value: string; label: string }

const INVITE_MAX_USES_OPTIONS: InviteMaxUsesOption[] = [
  { labelKey: 'maxUsesLabels.unlimited', value: '0' },
  { label: '1', value: '1' },
  { label: '5', value: '5' },
  { label: '10', value: '10' },
  { label: '25', value: '25' },
  { label: '100', value: '100' },
]

function userLabel(user: User) {
  return user.display_name ?? user.username
}

function inviteCode(invite: Invite) {
  return '_id' in invite ? invite._id : ''
}

function activeInvite(invites: Invite[], channelId?: string) {
  return invites.find((invite) => {
    if (!('_id' in invite) || !invite._id) return false
    if (getInviteInactiveReason(invite)) return false
    if (channelId && 'channel' in invite && invite.channel !== channelId) {
      return false
    }
    return true
  })
}

export function ServerInviteDialog({
  serverId,
  open,
  onOpenChange,
}: ServerInviteDialogProps) {
  const t = useTranslations('servers.invite')
  const auth = useAuth()
  const token = auth.session?.token
  const server = useSyncStore((s) => s.servers[serverId])
  const member = useSyncStore((s) => s.members[`${serverId}:${auth.user?._id}`])
  const canManageServerInvites = server
    ? canManageServer(server)
    : false

  const [busyUserId, setBusyUserId] = useState<string | null>(null)
  const [creatingLink, setCreatingLink] = useState(false)
  const [sentUserIds, setSentUserIds] = useState<string[]>([])
  const [friendSearch, setFriendSearch] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [invites, setInvites] = useState<Invite[]>([])
  const [activeInviteCode, setActiveInviteCode] = useState('')
  const [maxAgeSeconds, setMaxAgeSeconds] = useState('604800')
  const [maxUses, setMaxUses] = useState('0')
  const [selectedChannelId, setSelectedChannelId] = useState<string | undefined>()

  const textChannels = useSyncStore((s) =>
    listServerChannels(s, serverId, auth.user?._id).filter(
      (channel) => channel.channel_type === 'TextChannel',
    ),
  )
  const inviteChannels = useMemo(
    () =>
      server
        ? textChannels.filter((channel) =>
            canInviteToChannel(
              server,
              channel,
              member,
              auth.user?._id,
            ),
          )
        : [],
    [
      auth.user?._id,
      member,
      server,
      textChannels,
    ],
  )
  const inviteChannelKey = inviteChannels.map((channel) => channel._id).join('\0')
  const defaultChannelId = inviteChannels[0]?._id
  const activeChannelId =
    selectedChannelId &&
    inviteChannels.some((channel) => channel._id === selectedChannelId)
      ? selectedChannelId
      : defaultChannelId
  const activeChannelName =
    textChannels.find((channel) => channel._id === activeChannelId)?.name ??
    t('channelFallback')
  const members = useSyncStore((s) => s.members)
  const allFriends = useSyncStore((s) =>
    listUsersByRelationship(s, 'Friend', auth.user?._id),
  )
  /** Friends who are not on the server yet. */
  const friends = useMemo(
    () =>
      allFriends.filter(
        (user) => !user.bot && !members[`${serverId}:${user._id}`],
      ),
    [allFriends, members, serverId],
  )
  const visibleFriends = useMemo(() => {
    const query = friendSearch.trim().toLocaleLowerCase('ru-RU')
    if (!query) return friends
    return friends.filter((user) => {
      const text = `${user.display_name ?? ''} ${user.username}`
      return text.toLocaleLowerCase('ru-RU').includes(query)
    })
  }, [friendSearch, friends])
  const currentInviteUrl = activeInviteCode ? inviteUrl(activeInviteCode) : ''

  const loadInvites = useCallback(
    () =>
      Effect.gen(function*() {
        yield* Effect.sync(() => {
          setActiveInviteCode('')
          setInvites([])
        })
        if (!token || !canManageServerInvites) return

        const loadedInvites = yield* fetchServerInvitesEffect(token, serverId)
        yield* Effect.sync(() => setInvites(loadedInvites))
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
      ),
    [canManageServerInvites, serverId, t, token],
  )

  useEffect(() => {
    if (!open) return

    const accessibleChannelIds = new Set(inviteChannelKey.split('\0'))
    const existing =
      (activeChannelId ? activeInvite(invites, activeChannelId) : undefined) ??
      (!selectedChannelId
        ? activeInvite(
            invites.filter(
              (invite) =>
                'channel' in invite && accessibleChannelIds.has(invite.channel),
            ),
          )
        : undefined)

    setActiveInviteCode(existing ? inviteCode(existing) : '')
    if (
      existing &&
      'channel' in existing &&
      existing.channel !== activeChannelId
    ) {
      setSelectedChannelId(existing.channel)
    }
  }, [activeChannelId, inviteChannelKey, invites, open, selectedChannelId])

  useEffect(() => {
    if (!open) return
    setFriendSearch('')
    setSentUserIds([])
    const fiber = Effect.runFork(loadInvites())
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [loadInvites, open])

  function invalidateLink() {
    setActiveInviteCode('')
  }

  function ensureInviteLink() {
    return Effect.suspend(() => {
      const currentInvite = invites.find(
        (invite) => inviteCode(invite) === activeInviteCode,
      )
      if (currentInvite && !getInviteInactiveReason(currentInvite)) {
        return Effect.succeed(inviteUrl(activeInviteCode))
      }
      if (activeInviteCode) setActiveInviteCode('')

      if (!token || !activeChannelId) {
        return Effect.fail(
          new Error(t('noTextChannel')),
        )
      }

      const body: DataCreateInvite = {
        max_age_seconds: Number(maxAgeSeconds),
        max_uses: Number(maxUses),
      }

      return Effect.sync(() => setCreatingLink(true)).pipe(
        Effect.andThen(
          Effect.gen(function*() {
            const invite = yield* createChannelInviteEffect(
              token,
              activeChannelId,
              body,
            )
            const code = inviteCode(invite)

            if (!code) {
              return yield* Effect.fail(
                new Error(t('noCode')),
              )
            }

            const nextInvite = {
              ...invite,
              channel: invite.channel ?? activeChannelId,
            }
            yield* Effect.sync(() => {
              setInvites((current) => [nextInvite, ...current])
              setActiveInviteCode(code)
            })
            return inviteUrl(code)
          }),
        ),
        Effect.ensuring(Effect.sync(() => setCreatingLink(false))),
      )
    })
  }

  async function copyInviteLink() {
    await Effect.runPromise(
      ensureInviteLink().pipe(
        Effect.flatMap(writeClipboardTextEffect),
        Effect.matchEffect({
          onFailure: () =>
            Effect.sync(() => {
            }),
          onSuccess: () =>
            Effect.sync(() => {}),
        }),
      ),
    )
  }

  async function inviteFriend(user: User) {
    if (!token) return

    setBusyUserId(user._id)
    await Effect.runPromise(
      Effect.gen(function*() {
        const url = yield* ensureInviteLink()
        const channel = yield* openDirectMessageEffect(token, user._id)
        yield* Effect.sync(() => syncStore.upsertChannel(channel))
        const message = yield* sendChannelMessageEffect(
          token,
          channel._id,
          {
            content: t('message', {
              server: server?.name ?? t('serverFallback'),
              url,
            }),
          },
        )
        yield* Effect.sync(() => {
          syncStore.upsertMessage(message)
          setSentUserIds((current) =>
            current.includes(user._id) ? current : [...current, user._id],
          )
        })
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
        Effect.ensuring(Effect.sync(() => setBusyUserId(null))),
      ),
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-110">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>
            {t('title', { server: server?.name ?? t('serverFallback') })}
          </DialogTitle>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            {t('membersJoin')}{' '}
            <span className="inline-flex items-center gap-1 text-foreground">
              <HashIcon className="size-3.5" />
              {activeChannelName}
            </span>
          </p>
        </DialogHeader>

        <div className="px-5 pb-4">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={friendSearch}
              onChange={(event) => setFriendSearch(event.target.value)}
              placeholder={t('search')}
              aria-label={t('search')}
            />
          </InputGroup>
        </div>

        <div className="min-h-48 px-4 pb-4">
          <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
            {t('friends')}
          </p>
          {visibleFriends.length === 0 ? (
            <Empty>
              <EmptyDescription>{t('noFriends')}</EmptyDescription>
            </Empty>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto pr-1">
              {visibleFriends.map((user) => {
                const sent = sentUserIds.includes(user._id)
                const busy = busyUserId === user._id
                const label = userLabel(user)

                return (
                  <li key={user._id}>
                    <div className="flex items-center gap-3 rounded-md px-1 py-1.5">
                      <UserAvatar user={user} className="size-8 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">
                          {label}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {user.username}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={sent ? 'secondary' : 'default'}
                        disabled={busy || sent || creatingLink || !activeChannelId}
                        aria-label={t('inviteAria', { name: label })}
                        onClick={() => void inviteFriend(user)}
                      >
                        {sent ? (
                          <>
                            <CheckIcon className="size-4" />
                            {t('invited')}
                          </>
                        ) : busy ? (
                          t('sending')
                        ) : (
                          t('invite')
                        )}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="border-t bg-muted/20 px-5 py-4">
          <p className="mb-2 text-sm font-semibold">
            {t('orSendLink')}
          </p>
          <div className="flex gap-2">
            <div className="flex h-10 min-w-0 flex-1 items-center rounded-md border border-input bg-background px-3 text-sm">
              <span
                className={cn(
                  'truncate',
                  !currentInviteUrl && 'text-muted-foreground',
                )}
              >
                {currentInviteUrl || t('linkPending')}
              </span>
            </div>
            <Button
              type="button"
              disabled={creatingLink || !activeChannelId}
              onClick={() => void copyInviteLink()}
            >
              <CopyIcon className="size-4" />
              {t('copy')}
            </Button>
          </div>
          <p className="mt-2 text-xs">
            <Button
              type="button"
              variant="link"
              size="inline"
              onClick={() => setSettingsOpen((current) => !current)}
            >
              {t('editLink')}
              <ChevronDownIcon
                className={cn(
                  'size-3.5 transition-transform',
                  settingsOpen && 'rotate-180',
                )}
              />
            </Button>
          </p>

          {settingsOpen ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {inviteChannels.length > 0 ? (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="server-invite-channel">
                    {t('channel')}
                  </Label>
                  <NativeSelect
                    id="server-invite-channel"
                    value={activeChannelId ?? ''}
                    className="w-full"
                    onChange={(event) => {
                      setSelectedChannelId(event.target.value)
                      invalidateLink()
                    }}
                  >
                    {inviteChannels.map((channel) => (
                      <NativeSelectOption key={channel._id} value={channel._id}>
                        #{channel.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="server-invite-max-age">{t('expiry')}</Label>
                <NativeSelect
                  id="server-invite-max-age"
                  value={maxAgeSeconds}
                  className="w-full"
                  onChange={(event) => {
                    setMaxAgeSeconds(event.target.value)
                    invalidateLink()
                  }}
                >
                  {INVITE_MAX_AGE_OPTIONS.map((option) => (
                    <NativeSelectOption key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="server-invite-max-uses">
                  {t('maxUses')}
                </Label>
                <NativeSelect
                  id="server-invite-max-uses"
                  value={maxUses}
                  className="w-full"
                  onChange={(event) => {
                    setMaxUses(event.target.value)
                    invalidateLink()
                  }}
                >
                  {INVITE_MAX_USES_OPTIONS.map((option) => (
                    <NativeSelectOption key={option.value} value={option.value}>
                      {'labelKey' in option
                        ? t(option.labelKey)
                        : option.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
