import { useEffect, useMemo, useState } from 'react'
import type { Member, Role, Server, User } from '@syrnike13/api-types'
import { CheckIcon, SearchIcon } from 'lucide-react'
import { toast } from 'sonner'

import { UserAvatar } from '#/components/user/user-avatar'
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
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { editServerMember } from '#/features/api/servers-api'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { canToggleMemberRole } from '#/lib/member-roles'
import { cn } from '#/lib/utils'

const MAX_MEMBERS_PER_ADD = 30

type AddRoleMembersDialogProps = {
  server: Server
  role: Role
  open: boolean
  onOpenChange: (open: boolean) => void
}

type MemberEntry = { member: Member; user: User | undefined }

function memberDisplayName(user: User | undefined, member: Member) {
  if (user?.display_name) return user.display_name
  if (user?.username) return user.username
  return member._id.user
}

export function AddRoleMembersDialog({
  server,
  role,
  open,
  onOpenChange,
}: AddRoleMembersDialogProps) {
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [saving, setSaving] = useState(false)

  const token = auth.session?.token
  const actorUserId = auth.user?._id

  useEffect(() => {
    if (!open) {
      setQuery('')
      setSelectedIds(new Set())
    }
  }, [open])

  const candidates = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const list: MemberEntry[] = []

    for (const member of serverMembers) {
      if ((member.roles ?? []).includes(role._id)) continue
      if (
        !actorUserId ||
        !canToggleMemberRole(
          server,
          actorMember,
          actorUserId,
          member,
          role,
          true,
        )
      ) {
        continue
      }

      const user = users[member._id.user]
      if (normalized) {
        const label = memberDisplayName(user, member).toLowerCase()
        const username = user?.username.toLowerCase() ?? ''
        if (!label.includes(normalized) && !username.includes(normalized)) {
          continue
        }
      }

      list.push({ member, user })
    }

    return list.sort((a, b) =>
      memberDisplayName(a.user, a.member).localeCompare(
        memberDisplayName(b.user, b.member),
        'ru',
      ),
    )
  }, [
    actorMember,
    actorUserId,
    query,
    role,
    server,
    serverMembers,
    users,
  ])

  const atSelectionLimit = selectedIds.size >= MAX_MEMBERS_PER_ADD

  function toggleMember(userId: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(userId)) {
        next.delete(userId)
        return next
      }
      if (next.size >= MAX_MEMBERS_PER_ADD) return current
      next.add(userId)
      return next
    })
  }

  async function submit() {
    if (!token || selectedIds.size === 0) return

    setSaving(true)
    try {
      const updates = await Promise.all(
        Array.from(selectedIds).map(async (userId) => {
          const targetMember = serverMembers.find(
            (member) => member._id.user === userId,
          )
          if (!targetMember) return null

          const nextRoles = [
            ...new Set([...(targetMember.roles ?? []), role._id]),
          ]
          return editServerMember(token, server._id, userId, {
            roles: nextRoles,
          })
        }),
      )

      const applied = updates.filter(
        (member): member is Member => member !== null,
      )
      if (applied.length > 0) {
        syncStore.upsertMembers(applied)
      }

      onOpenChange(false)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Не удалось добавить участников',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(32rem,90vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="space-y-2 px-6 pt-6 pb-4 text-left">
          <DialogTitle>Добавить участников</DialogTitle>
          <DialogDescription>
            Выберите до {MAX_MEMBERS_PER_ADD} участников для роли{' '}
            <span className="font-medium text-foreground">{role.name}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              placeholder="Поиск участников"
              className="bg-muted/40 pl-9"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>

        <p className="px-6 pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Участники
        </p>

        <ScrollArea className="min-h-0 flex-1 px-3">
          <ul className="pb-2">
            {candidates.map(({ member, user }) => {
              const selected = selectedIds.has(member._id.user)
              const disabled = !selected && atSelectionLimit

              return (
                <li key={member._id.user}>
                  <button
                    type="button"
                    disabled={disabled}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors',
                      selected ? 'bg-accent/60' : 'hover:bg-muted/40',
                      disabled && 'cursor-not-allowed opacity-50',
                    )}
                    onClick={() => toggleMember(member._id.user)}
                  >
                    <span
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-muted-foreground/40 bg-transparent',
                      )}
                      aria-hidden
                    >
                      {selected ? <CheckIcon className="size-3" /> : null}
                    </span>
                    <UserAvatar
                      user={user}
                      className="size-8"
                      showPresence={false}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <span className="font-medium text-foreground">
                        {memberDisplayName(user, member)}
                      </span>
                      {user?.username ? (
                        <span className="text-muted-foreground">
                          {' '}
                          {user.username}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {candidates.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {query.trim()
                ? 'Участники не найдены.'
                : 'Нет участников, которых можно добавить.'}
            </p>
          ) : null}
        </ScrollArea>

        <DialogFooter className="grid grid-cols-2 gap-2 border-t border-border p-4 sm:justify-stretch">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Отмена
          </Button>
          <Button
            type="button"
            className="w-full"
            disabled={saving || selectedIds.size === 0}
            onClick={() => void submit()}
          >
            Добавить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
