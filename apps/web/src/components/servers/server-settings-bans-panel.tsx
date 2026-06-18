import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BannedUser, ServerBan } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { useAuth } from '#/features/auth/auth-context'
import {
  fetchServerBans,
  unbanServerMember,
} from '#/features/api/servers-api'

type ServerSettingsBansPanelProps = {
  serverId: string
}

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
  onRemove: (userLabel: string) => void
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
        onClick={() => onRemove(userLabel)}
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

  async function removeBan(userId: string, userLabel: string) {
    if (!token) return
    if (!window.confirm(`Снять бан с ${userLabel}?`)) return

    setRemovingUserId(userId)
    try {
      await unbanServerMember(token, serverId, userId)
      await bansQuery.refetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось снять бан')
    } finally {
      setRemovingUserId(null)
    }
  }

  const bans = bansQuery.data?.bans ?? []

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">Баны</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Заблокированные участники сервера.
        </p>
      </div>

      {bansQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Загрузка...</p>
      ) : bansQuery.error ? (
        <p className="text-sm text-destructive">Не удалось загрузить баны.</p>
      ) : bans.length === 0 ? (
        <p className="text-sm text-muted-foreground">Банов пока нет</p>
      ) : (
        <ul className="space-y-2">
          {bans.map((ban) => (
            <BanRow
              key={`${ban._id.server}:${ban._id.user}`}
              ban={ban}
              user={usersById.get(ban._id.user)}
              removing={removingUserId === ban._id.user}
              onRemove={(userLabel) => void removeBan(ban._id.user, userLabel)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
