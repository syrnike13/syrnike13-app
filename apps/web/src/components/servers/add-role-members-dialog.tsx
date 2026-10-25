import { useEffect, useMemo, useState } from 'react'
import { SearchInput } from '#/components/ui/search-input'
import type { Member, Role, Server, User } from '@syrnike13/api-types'
import { Effect, Exit } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '@syrnike13/ui/primitives/button'
import { Checkbox } from '@syrnike13/ui/primitives/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { Separator } from '@syrnike13/ui/primitives/separator'
import { useAuth } from '#/features/auth/auth-context'
import { editServerMemberEffect } from '#/features/api/servers-api'
import { useServerMembersSync } from '#/features/sync/server-members-sync'
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
  const nickname = member.nickname?.trim()
  if (nickname) return nickname
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
  const t = useTranslations('servers.addMembers')
  const auth = useAuth()
  useServerMembersSync(server._id, auth.session?.token, open)
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
      const results = await Effect.runPromise(
        Effect.all(
          Array.from(selectedIds).map((userId) => {
            const targetMember = serverMembers.find(
              (member) => member._id.user === userId,
            )
            if (!targetMember) return Effect.succeed(null).pipe(Effect.exit)

            const nextRoles = [
              ...new Set([...(targetMember.roles ?? []), role._id]),
            ]
            return editServerMemberEffect(
              token,
              server._id,
              userId,
              {
                roles: nextRoles,
              },
            ).pipe(Effect.exit)
          }),
          { concurrency: 'unbounded' },
        ),
      )

      const applied = results.flatMap((result) =>
        Exit.isSuccess(result) && result.value ? [result.value] : [],
      )
      const hasFailures = results.some(Exit.isFailure)

      if (applied.length > 0) {
        syncStore.upsertMembers(applied)
      }

      if (hasFailures) {
        return
      }

      onOpenChange(false)
    } catch (error) {
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-role-members flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="space-y-2 px-6 pt-6 pb-4 text-left">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', { max: MAX_MEMBERS_PER_ADD })}{' '}
            <span className="font-medium text-foreground">{role.name}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-3">
          <SearchInput
            value={query}
            placeholder={t('search')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <p className="px-6 pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t('members')}
        </p>

        <ScrollArea className="min-h-0 flex-1">
          <ul className="px-3 pb-2">
            {candidates.map(({ member, user }) => {
              const selected = selectedIds.has(member._id.user)
              const disabled = !selected && atSelectionLimit

              return (
                <li key={member._id.user}>
                  <label
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors',
                      selected ? 'bg-accent/60' : 'hover:bg-muted/40',
                      disabled && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <Checkbox
                      checked={selected}
                      disabled={disabled}
                      aria-label={memberDisplayName(user, member)}
                      onCheckedChange={() => toggleMember(member._id.user)}
                    />
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
                  </label>
                </li>
              )
            })}
          </ul>
          {candidates.length === 0 ? (
            <Empty>
              <EmptyDescription>
                {query.trim() ? t('noResults') : t('noCandidates')}
              </EmptyDescription>
            </Empty>
          ) : null}
        </ScrollArea>

        <Separator />
        <DialogFooter variant="bare" className="grid grid-cols-2 gap-2 sm:justify-stretch">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button
            type="button"
            className="w-full"
            disabled={saving || selectedIds.size === 0}
            onClick={() => void submit()}
          >
            {t('add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
