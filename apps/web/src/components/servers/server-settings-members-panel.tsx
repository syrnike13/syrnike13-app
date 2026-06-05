import { useMemo, useState } from 'react'

import { MemberRolesEditor } from '#/components/servers/member-roles-editor'
import { Input } from '#/components/ui/input'
import { UserAvatar } from '#/components/user/user-avatar'
import { listServerMembers } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { canEditAnyMemberRole } from '#/lib/member-roles'
import { useAuth } from '#/features/auth/auth-context'
import { cn } from '#/lib/utils'

type ServerSettingsMembersPanelProps = {
  serverId: string
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
          Назначайте роли участникам сервера.
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
              const canManage = auth.user?._id
                ? canEditAnyMemberRole(
                    server,
                    actorMember,
                    auth.user._id,
                    member,
                  )
                : false

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
              <MemberRolesEditor
                server={server}
                targetMember={selectedEntry.member}
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
