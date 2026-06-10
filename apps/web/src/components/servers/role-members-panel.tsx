import { useMemo, useState } from 'react'
import type { Member, Role, Server, User } from '@syrnike13/api-types'
import { SearchIcon, XIcon } from '#/components/icons'
import { toast } from 'sonner'

import { AddRoleMembersDialog } from '#/components/servers/add-role-members-dialog'
import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { useAuth } from '#/features/auth/auth-context'
import { editServerMember } from '#/features/api/servers-api'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { canToggleMemberRole } from '#/lib/member-roles'
import { canAssignRole } from '#/lib/permissions'
import { cn } from '#/lib/utils'

type RoleMembersPanelProps = {
  server: Server
  role: Role
  className?: string
}

type MemberEntry = { member: Member; user: User | undefined }

function memberDisplayName(user: User | undefined, member: Member) {
  if (user?.display_name) return user.display_name
  if (user?.username) return user.username
  return member._id.user
}

function matchesQuery(
  member: Member,
  user: User | undefined,
  normalized: string,
) {
  if (!normalized) return true
  const label = memberDisplayName(user, member).toLowerCase()
  const username = user?.username.toLowerCase() ?? ''
  return label.includes(normalized) || username.includes(normalized)
}

export function RoleMembersPanel({
  server,
  role,
  className,
}: RoleMembersPanelProps) {
  const auth = useAuth()
  const actorMember = useSyncStore((state) =>
    auth.user?._id
      ? state.members[`${server._id}:${auth.user._id}`]
      : undefined,
  )
  const users = useSyncStore((state) => state.users)
  const serverMembers = useSyncStore((state) =>
    Object.values(state.members).filter(
      (member) => member._id.server === server._id,
    ),
  )

  const [query, setQuery] = useState('')
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [savingMemberId, setSavingMemberId] = useState<string | null>(null)

  const token = auth.session?.token
  const actorUserId = auth.user?._id

  const canAddMembers = Boolean(
    actorUserId &&
      canAssignRole(server, actorMember, actorUserId, role.rank ?? 0),
  )

  const withRole = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const list: MemberEntry[] = []

    for (const member of serverMembers) {
      if (!(member.roles ?? []).includes(role._id)) continue
      const user = users[member._id.user]
      if (!matchesQuery(member, user, normalized)) continue
      list.push({ member, user })
    }

    return list.sort((a, b) =>
      memberDisplayName(a.user, a.member).localeCompare(
        memberDisplayName(b.user, b.member),
        'ru',
      ),
    )
  }, [query, role._id, serverMembers, users])

  async function removeMember(targetMember: Member) {
    if (!token || !actorUserId) return

    if (
      !canToggleMemberRole(
        server,
        actorMember,
        actorUserId,
        targetMember,
        role,
        false,
      )
    ) {
      return
    }

    const nextRoles = (targetMember.roles ?? []).filter((id) => id !== role._id)

    setSavingMemberId(targetMember._id.user)
    try {
      const updated = await editServerMember(
        token,
        server._id,
        targetMember._id.user,
        { roles: nextRoles },
      )
      syncStore.upsertMembers([updated])
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Не удалось обновить участника',
      )
    } finally {
      setSavingMemberId(null)
    }
  }

  function renderMemberRow({ member, user }: MemberEntry) {
    const canRemove = Boolean(
      actorUserId &&
        canToggleMemberRole(
          server,
          actorMember,
          actorUserId,
          member,
          role,
          false,
        ),
    )

    const disabled = savingMemberId !== null || !canRemove
    const displayName = memberDisplayName(user, member)

    return (
      <li
        key={member._id.user}
        className="group flex items-center gap-3 rounded-md py-2 pr-1 pl-1 hover:bg-muted/40"
      >
        <UserAvatar user={user} className="size-8" showPresence={false} />
        <div className="min-w-0 flex-1 truncate text-sm">
          <span className="font-medium text-foreground">{displayName}</span>
          {user?.username ? (
            <span className="text-muted-foreground"> {user.username}</span>
          ) : null}
        </div>
        {canRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-full text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            disabled={disabled}
            title="Убрать роль"
            onClick={() => void removeMember(member)}
          >
            <XIcon className="size-4" />
          </Button>
        ) : null}
      </li>
    )
  }

  return (
    <>
      <div className={cn('space-y-4', className)}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              placeholder="Поиск участников"
              className="bg-muted/40 pl-9"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {canAddMembers ? (
            <Button
              type="button"
              className="shrink-0 sm:min-w-[11rem]"
              onClick={() => setAddDialogOpen(true)}
            >
              Добавить участников
            </Button>
          ) : null}
        </div>

        <ul className="space-y-0.5">
          {withRole.map((entry) => renderMemberRow(entry))}
        </ul>

        {withRole.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {query.trim()
              ? 'Участники не найдены.'
              : 'У этой роли пока нет участников.'}
          </p>
        ) : null}
      </div>

      {canAddMembers ? (
        <AddRoleMembersDialog
          server={server}
          role={role}
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
        />
      ) : null}
    </>
  )
}
