import { useEffect, useMemo, useState } from 'react'
import type { Member, Server, User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { MemberRolesEditor } from '#/components/servers/member-roles-editor'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { UserAvatar } from '#/components/user/user-avatar'
import {
  banServerMember,
  editServerMember,
  kickServerMember,
} from '#/features/api/servers-api'
import { listServerMembers } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { canEditAnyMemberRole } from '#/lib/member-roles'
import { useAuth } from '#/features/auth/auth-context'
import {
  canBanServerMember,
  canChangeMemberNickname,
  canKickServerMember,
  canTimeoutServerMember,
} from '#/lib/permissions'
import { cn } from '#/lib/utils'

type ServerSettingsMembersPanelProps = {
  serverId: string
}

function memberDisplayName(user: User) {
  return user.display_name ?? user.username
}

function ServerMemberNicknamePanel({
  server,
  actorMember,
  targetMember,
  token,
  userId,
}: {
  server: Server
  actorMember: Member | undefined
  targetMember: Member
  token: string | undefined
  userId: string | undefined
}) {
  const [nickname, setNickname] = useState(targetMember.nickname ?? '')
  const [saving, setSaving] = useState(false)
  const canChangeNickname = canChangeMemberNickname(
    server,
    actorMember,
    userId,
    targetMember,
  )

  useEffect(() => {
    setNickname(targetMember.nickname ?? '')
  }, [targetMember._id.user, targetMember.nickname])

  if (!canChangeNickname) return null

  const currentNickname = targetMember.nickname ?? ''
  const normalizedNickname = nickname.trim()
  const changed = normalizedNickname !== currentNickname

  async function saveNickname() {
    if (!token || !changed) return

    setSaving(true)
    try {
      const updated = await editServerMember(
        token,
        server._id,
        targetMember._id.user,
        normalizedNickname
          ? { nickname: normalizedNickname }
          : { remove: ['Nickname'] },
      )
      syncStore.upsertMembers([updated])
      toast.success('Никнейм обновлён')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось обновить никнейм',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`member-nickname-${targetMember._id.user}`}>
          Никнейм на сервере
        </Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={`member-nickname-${targetMember._id.user}`}
            value={nickname}
            maxLength={32}
            onChange={(event) => setNickname(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            disabled={saving || !changed}
            onClick={() => void saveNickname()}
          >
            Сохранить ник
          </Button>
        </div>
      </div>
    </section>
  )
}

function ServerMemberModerationPanel({
  server,
  actorMember,
  targetMember,
  targetUser,
  token,
  userId,
}: {
  server: Server
  actorMember: Member | undefined
  targetMember: Member
  targetUser: User
  token: string | undefined
  userId: string | undefined
}) {
  const [reason, setReason] = useState('')
  const [pendingAction, setPendingAction] = useState<string | null>(null)

  const canKick = canKickServerMember(server, actorMember, userId, targetMember)
  const canBan = canBanServerMember(server, actorMember, userId, targetMember)
  const canTimeout = canTimeoutServerMember(
    server,
    actorMember,
    userId,
    targetMember,
  )
  const timeoutExpiresAt = targetMember.timeout
    ? Date.parse(targetMember.timeout)
    : Number.NaN
  const hasActiveTimeout =
    Number.isFinite(timeoutExpiresAt) && timeoutExpiresAt > Date.now()

  const targetLabel = memberDisplayName(targetUser)
  const reasonBody = reason.trim() ? { reason: reason.trim() } : {}

  async function kickMember() {
    if (!token || !canKick) return
    if (!window.confirm(`Исключить ${targetLabel} с сервера?`)) return

    setPendingAction('kick')
    try {
      await kickServerMember(token, server._id, targetMember._id.user, reasonBody)
      syncStore.removeServerMember(server._id, targetMember._id.user)
      toast.success('Участник исключён')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось исключить',
      )
    } finally {
      setPendingAction(null)
    }
  }

  async function banMember() {
    if (!token || !canBan) return
    if (!window.confirm(`Забанить ${targetLabel}?`)) return

    setPendingAction('ban')
    try {
      await banServerMember(token, server._id, targetMember._id.user, reasonBody)
      syncStore.removeServerMember(server._id, targetMember._id.user)
      toast.success('Участник забанен')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось забанить')
    } finally {
      setPendingAction(null)
    }
  }

  async function timeoutMember(durationMs: number) {
    if (!token || !canTimeout) return

    const timeout = new Date(Date.now() + durationMs).toISOString()
    setPendingAction('timeout')
    try {
      const updated = await editServerMember(
        token,
        server._id,
        targetMember._id.user,
        { timeout },
      )
      syncStore.upsertMembers([updated])
      toast.success('Тайм-аут выдан')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось выдать тайм-аут',
      )
    } finally {
      setPendingAction(null)
    }
  }

  async function removeTimeoutMember() {
    if (!token || !canTimeout || !hasActiveTimeout) return

    setPendingAction('remove-timeout')
    try {
      const updated = await editServerMember(
        token,
        server._id,
        targetMember._id.user,
        { remove: ['Timeout'] },
      )
      syncStore.upsertMembers([updated])
      toast.success('Тайм-аут снят')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось снять тайм-аут',
      )
    } finally {
      setPendingAction(null)
    }
  }

  if (!canKick && !canBan && !canTimeout) {
    return null
  }

  return (
    <section className="space-y-3 border-t border-border/60 pt-4">
      <div>
        <h4 className="text-sm font-semibold">Модерация</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          Действия пишутся в журнал аудита сервера.
        </p>
      </div>

      {(canKick || canBan) ? (
        <div className="space-y-1.5">
          <Label htmlFor={`member-moderation-reason-${targetMember._id.user}`}>
            Причина модерации
          </Label>
          <Input
            id={`member-moderation-reason-${targetMember._id.user}`}
            value={reason}
            maxLength={256}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canTimeout ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pendingAction !== null}
            onClick={() => void timeoutMember(60 * 60 * 1000)}
          >
            Тайм-аут на 1 час
          </Button>
        ) : null}
        {canTimeout && hasActiveTimeout ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pendingAction !== null}
            onClick={() => void removeTimeoutMember()}
          >
            Снять тайм-аут
          </Button>
        ) : null}
        {canKick ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={pendingAction !== null}
            onClick={() => void kickMember()}
          >
            Исключить
          </Button>
        ) : null}
        {canBan ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={pendingAction !== null}
            onClick={() => void banMember()}
          >
            Забанить
          </Button>
        ) : null}
      </div>
    </section>
  )
}

export function ServerSettingsMembersPanel({
  serverId,
}: ServerSettingsMembersPanelProps) {
  const auth = useAuth()
  const server = useSyncStore((s) => s.servers[serverId])
  const members = useSyncStore((s) => listServerMembers(s, serverId))
  const actorMember = useSyncStore((s) =>
    auth.user?._id ? s.members[`${serverId}:${auth.user._id}`] : undefined,
  )
  const [query, setQuery] = useState('')
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)

  const filteredMembers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return members
    return members.filter(({ user }) => {
      const name = user.display_name ?? user.username
      return (
        name.toLowerCase().includes(normalized) ||
        user.username.toLowerCase().includes(normalized)
      )
    })
  }, [members, query])

  const selectedEntry = filteredMembers.find(
    (entry) => entry.user._id === selectedUserId,
  )

  if (!server) return null

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">Участники</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Назначайте роли, никнеймы и модераторские ограничения.
        </p>
      </div>

      <div className="grid min-h-[28rem] gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск участников…"
            className="h-9"
          />
          <ul className="max-h-[24rem] space-y-1 overflow-y-auto pr-1">
            {filteredMembers.map(({ member, user }) => {
              const canManageRoles = auth.user?._id
                ? canEditAnyMemberRole(
                    server,
                    actorMember,
                    auth.user._id,
                    member,
                  )
                : false
              const canManage =
                canManageRoles ||
                canChangeMemberNickname(
                  server,
                  actorMember,
                  auth.user?._id,
                  member,
                ) ||
                canKickServerMember(server, actorMember, auth.user?._id, member) ||
                canBanServerMember(server, actorMember, auth.user?._id, member) ||
                canTimeoutServerMember(
                  server,
                  actorMember,
                  auth.user?._id,
                  member,
                )

              return (
                <li key={user._id}>
                  <button
                    type="button"
                    disabled={!canManage}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors',
                      selectedUserId === user._id
                        ? 'border-primary/40 bg-accent'
                        : 'border-border hover:bg-muted/40',
                      !canManage && 'cursor-not-allowed opacity-50',
                    )}
                    onClick={() => setSelectedUserId(user._id)}
                  >
                    <UserAvatar user={user} className="size-8" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {user.display_name ?? user.username}
                    </span>
                  </button>
                </li>
              )
            })}
            {filteredMembers.length === 0 ? (
              <li className="px-2 py-4 text-sm text-muted-foreground">
                Участники не найдены
              </li>
            ) : null}
          </ul>
        </div>

        <div className="min-w-0 rounded-lg border border-border bg-card/40 p-4 sm:p-5">
          {selectedEntry ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 border-b border-border/60 pb-4">
                <UserAvatar user={selectedEntry.user} className="size-12" />
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    {selectedEntry.user.display_name ??
                      selectedEntry.user.username}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    @{selectedEntry.user.username}
                  </p>
                </div>
              </div>
              <ServerMemberNicknamePanel
                server={server}
                actorMember={actorMember}
                targetMember={selectedEntry.member}
                token={auth.session?.token}
                userId={auth.user?._id}
              />
              <MemberRolesEditor
                server={server}
                targetMember={selectedEntry.member}
              />
              <ServerMemberModerationPanel
                server={server}
                actorMember={actorMember}
                targetMember={selectedEntry.member}
                targetUser={selectedEntry.user}
                token={auth.session?.token}
                userId={auth.user?._id}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Выберите участника, чтобы управлять его ролями.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
