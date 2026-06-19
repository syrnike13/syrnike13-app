import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BannedUser, ServerBan } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { SearchIcon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { useAuth } from '#/features/auth/auth-context'
import {
  banServerMember,
  fetchServerBans,
  unbanServerMember,
} from '#/features/api/servers-api'

type ServerSettingsBansPanelProps = {
  serverId: string
}

const BAN_DELETE_MESSAGE_PRESETS = [
  { label: 'Не удалять', seconds: 0 },
  { label: '1 час', seconds: 60 * 60 },
  { label: '24 часа', seconds: 24 * 60 * 60 },
  { label: '7 дней', seconds: 7 * 24 * 60 * 60 },
]

function bannedUserLabel(user: BannedUser | undefined, userId: string) {
  return user?.username ?? userId
}

function BanRow({
  ban,
  user,
  removing,
  onRemove,
}: {
  ban: ServerBan
  user: BannedUser | undefined
  removing: boolean
  onRemove: (userId: string, userLabel: string) => void
}) {
  const userId = ban._id.user
  const userLabel = bannedUserLabel(user, userId)

  return (
    <li className="flex flex-col gap-3 rounded-md border border-border px-3 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{userLabel}</p>
        <p className="truncate text-xs text-muted-foreground">{userId}</p>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {ban.reason ?? 'Причина не указана'}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={removing}
        onClick={() => onRemove(userId, userLabel)}
      >
        Разбанить
      </Button>
    </li>
  )
}

export function ServerSettingsBansPanel({
  serverId,
}: ServerSettingsBansPanelProps) {
  const auth = useAuth()
  const token = auth.session?.token
  const [removingUserId, setRemovingUserId] = useState<string | null>(null)
  const [unbanTarget, setUnbanTarget] = useState<{
    userId: string
    userLabel: string
  } | null>(null)
  const [unbanReason, setUnbanReason] = useState('')
  const [banUserId, setBanUserId] = useState('')
  const [banReason, setBanReason] = useState('')
  const [banDeleteMessageSeconds, setBanDeleteMessageSeconds] = useState('0')
  const [banning, setBanning] = useState(false)
  const [query, setQuery] = useState('')

  const bansQuery = useQuery({
    queryKey: ['server-bans', serverId],
    enabled: Boolean(token),
    queryFn: () => fetchServerBans(token!, serverId),
  })

  const usersById = useMemo(() => {
    return new Map(
      (bansQuery.data?.users ?? []).map((user) => [user._id, user]),
    )
  }, [bansQuery.data?.users])

  function requestRemoveBan(userId: string, userLabel: string) {
    setUnbanTarget({ userId, userLabel })
  }

  function closeUnbanDialog() {
    setUnbanTarget(null)
    setUnbanReason('')
  }

  async function removeBan() {
    if (!token || !unbanTarget) return

    const body = unbanReason.trim() ? { reason: unbanReason.trim() } : {}

    setRemovingUserId(unbanTarget.userId)
    try {
      await unbanServerMember(token, serverId, unbanTarget.userId, body)
      await bansQuery.refetch()
      closeUnbanDialog()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось снять бан')
    } finally {
      setRemovingUserId(null)
    }
  }

  async function createBan() {
    if (!token) return

    const targetUserId = banUserId.trim()
    if (!targetUserId) {
      toast.error('Укажите ID пользователя')
      return
    }

    const selectedDeleteMessageSeconds = Number(banDeleteMessageSeconds)
    const body = {
      ...(banReason.trim() ? { reason: banReason.trim() } : {}),
      ...(selectedDeleteMessageSeconds > 0
        ? { delete_message_seconds: selectedDeleteMessageSeconds }
        : {}),
    }

    setBanning(true)
    try {
      await banServerMember(token, serverId, targetUserId, body)
      setBanUserId('')
      setBanReason('')
      setBanDeleteMessageSeconds('0')
      await bansQuery.refetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось выдать бан')
    } finally {
      setBanning(false)
    }
  }

  const bans = bansQuery.data?.bans ?? []
  const filteredBans = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return bans

    return bans.filter((ban) => {
      const userId = ban._id.user
      const user = usersById.get(userId)
      const userLabel = bannedUserLabel(user, userId).toLowerCase()
      const reason = ban.reason?.toLowerCase() ?? ''

      return (
        userLabel.includes(normalized) ||
        userId.toLowerCase().includes(normalized) ||
        reason.includes(normalized)
      )
    })
  }, [bans, query, usersById])

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">Баны</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Заблокированные участники сервера.
        </p>
      </div>

      <section className="space-y-3 rounded-md border border-border px-3 py-3">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <Label htmlFor="ban-user-id">ID пользователя для бана</Label>
            <Input
              id="ban-user-id"
              value={banUserId}
              disabled={banning}
              onChange={(event) => setBanUserId(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ban-reason">Причина бана</Label>
            <Input
              id="ban-reason"
              value={banReason}
              maxLength={256}
              disabled={banning}
              onChange={(event) => setBanReason(event.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="ban-delete-messages">
              Удалить историю сообщений
            </Label>
            <select
              id="ban-delete-messages"
              value={banDeleteMessageSeconds}
              className="h-9 w-full rounded-md border border-input bg-muted/40 px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-border dark:bg-secondary dark:text-secondary-foreground"
              disabled={banning}
              onChange={(event) => setBanDeleteMessageSeconds(event.target.value)}
            >
              {BAN_DELETE_MESSAGE_PRESETS.map((preset) => (
                <option key={preset.seconds} value={String(preset.seconds)}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            variant="destructive"
            disabled={banning || !banUserId.trim()}
            onClick={() => void createBan()}
          >
            Забанить пользователя
          </Button>
        </div>
      </section>

      {bans.length > 0 ? (
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск банов…"
            className="h-9 bg-muted/40 pl-9"
          />
        </div>
      ) : null}

      {bansQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Загрузка...</p>
      ) : bansQuery.error ? (
        <p className="text-sm text-destructive">Не удалось загрузить баны.</p>
      ) : bans.length === 0 ? (
        <p className="text-sm text-muted-foreground">Банов пока нет</p>
      ) : filteredBans.length === 0 ? (
        <p className="text-sm text-muted-foreground">Баны не найдены</p>
      ) : (
        <ul className="space-y-2">
          {filteredBans.map((ban) => (
            <BanRow
              key={`${ban._id.server}:${ban._id.user}`}
              ban={ban}
              user={usersById.get(ban._id.user)}
              removing={removingUserId === ban._id.user}
              onRemove={requestRemoveBan}
            />
          ))}
        </ul>
      )}
      <Dialog
        open={unbanTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removingUserId) {
            closeUnbanDialog()
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Снять бан с {unbanTarget?.userLabel}?</DialogTitle>
            <DialogDescription>
              Пользователь сможет снова зайти на сервер по приглашению.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label htmlFor="unban-reason">Причина снятия бана</Label>
            <Input
              id="unban-reason"
              value={unbanReason}
              maxLength={256}
              disabled={removingUserId !== null}
              onChange={(event) => setUnbanReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={removingUserId !== null}
              onClick={closeUnbanDialog}
            >
              Отмена
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={removingUserId !== null}
              onClick={() => void removeBan()}
            >
              Снять бан
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
