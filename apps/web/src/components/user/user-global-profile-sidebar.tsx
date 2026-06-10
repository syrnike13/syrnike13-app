import { useQuery } from '@tanstack/react-query'
import {
  BanIcon,
  CopyIcon,
  Loader2Icon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SettingsIcon,
  XIcon,
} from '#/components/icons'
import { useMemo, useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { EditMemberRolesDialog } from '#/components/servers/edit-member-roles-dialog'
import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { FloatingMenuItem } from '#/components/ui/floating-menu'
import { useAuth } from '#/features/auth/auth-context'
import { editServerMember } from '#/features/api/servers-api'
import { fetchUserProfile } from '#/features/api/users-api'
import { queryKeys } from '#/lib/api/query-keys'
import { userBannerUrl } from '#/lib/media'
import {
  getUserPresence,
  presenceModeLabel,
  userStatusSubtitle,
} from '#/lib/presence'
import {
  memberRoleEntries,
  type MemberRoleEntry,
} from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  canEditAnyMemberRole,
  canToggleMemberRole,
} from '#/lib/member-roles'
import { FxImage } from '#/components/ui/fx-image'
import { cn } from '#/lib/utils'

type UserGlobalProfileSidebarProps = {
  user: User
  serverId?: string
  isSelf: boolean
  busy: boolean
  onOpenDm: () => void
  onCopyId: () => void
  onBlock: () => void
  onEditProfile: () => void
}

function roleDotStyle(colour: string | null) {
  if (!colour) return { backgroundColor: 'var(--muted-foreground)' }
  return { backgroundColor: colour.startsWith('#') ? colour : `#${colour}` }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

export function UserGlobalProfileSidebar({
  user,
  serverId,
  isSelf,
  busy,
  onOpenDm,
  onCopyId,
  onBlock,
  onEditProfile,
}: UserGlobalProfileSidebarProps) {
  const auth = useAuth()
  const token = auth.session?.token
  const displayName = user.display_name ?? user.username
  const customStatus = user.status?.text?.trim()
  const presenceLabel = presenceModeLabel(getUserPresence(user))

  const [rolesDialogOpen, setRolesDialogOpen] = useState(false)
  const [removingRoleId, setRemovingRoleId] = useState<string | null>(null)

  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const member = useSyncStore((s) =>
    serverId ? s.members[`${serverId}:${user._id}`] : undefined,
  )
  const actorMember = useSyncStore((s) =>
    serverId && auth.user?._id
      ? s.members[`${serverId}:${auth.user._id}`]
      : undefined,
  )
  const roles: MemberRoleEntry[] = member
    ? memberRoleEntries(server, member)
    : []
  const actorUserId = auth.user?._id

  const canEditRoles = useMemo(
    () =>
      Boolean(
        server &&
          member &&
          actorUserId &&
          canEditAnyMemberRole(server, actorMember, actorUserId, member),
      ),
    [actorMember, actorUserId, member, server],
  )

  const profileQuery = useQuery({
    queryKey: queryKeys.users.profile(user._id),
    queryFn: () => fetchUserProfile(token!, user._id),
    enabled: Boolean(token),
    staleTime: 60_000,
  })

  const bannerUrl = userBannerUrl(profileQuery.data?.background)
  const profileBio = profileQuery.data?.content?.trim()

  async function removeRole(roleId: string) {
    if (!token || !actorUserId || !server || !member) return
    const role = server.roles?.[roleId]
    if (!role) return
    if (!canToggleMemberRole(server, actorMember, actorUserId, member, role, false)) return
    setRemovingRoleId(roleId)
    try {
      const nextRoles = (member.roles ?? []).filter((id) => id !== roleId)
      const updated = await editServerMember(token, server._id, member._id.user, { roles: nextRoles })
      syncStore.upsertMembers([updated])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось убрать роль')
    } finally {
      setRemovingRoleId(null)
    }
  }

  const showServerSection = Boolean(serverId && member)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      {/* Inner card */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-secondary">
        {/* Banner */}
        <div className="relative shrink-0">
          <div
            className={cn(
              'h-[140px] w-full overflow-hidden rounded-t-xl',
              !bannerUrl && 'bg-gradient-to-br from-primary via-chart-4 to-sidebar-primary',
            )}
          >
            {bannerUrl ? (
              <>
                <FxImage
                  src={bannerUrl}
                  wrapperClassName="block h-full w-full"
                  className="h-full w-full object-cover"
                />
                <div className="pointer-events-none absolute inset-0 bg-black/20" aria-hidden />
              </>
            ) : null}
          </div>
          {/* Avatar — straddling banner */}
          <div className="absolute -bottom-12 left-4 z-10">
            <UserAvatar
              user={user}
              className="size-24"
              fallbackClassName="size-24 text-2xl ring-[5px] ring-secondary bg-secondary"
              showPresence
              presenceRingClassName="border-secondary"
              presenceClassName="size-7 translate-x-[14%] translate-y-[14%] border-[3px]"
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex min-h-0 flex-1 flex-col px-4 pt-14 pb-4">
        {/* Name + username */}
        <h2 className="truncate text-xl font-bold leading-tight text-foreground">
          {displayName}
        </h2>
        <p className="truncate text-sm text-muted-foreground">
          {user.display_name ? `@${user.username}` : user.username}
          {customStatus ? (
            <>
              <span className="text-muted-foreground/50"> · </span>
              <span>{customStatus}</span>
            </>
          ) : null}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {customStatus ? presenceLabel : userStatusSubtitle(user)}
        </p>

        {/* Action buttons */}
        <div className="mt-3 flex gap-1.5">
          {isSelf ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              className="flex-1 gap-2"
              onClick={onEditProfile}
            >
              <SettingsIcon className="size-3.5" />
              Редактировать
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                className="min-w-0 flex-1 gap-1.5"
                onClick={onOpenDm}
              >
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <MessageCircleIcon className="size-3.5" />
                )}
                <span className="truncate">Сообщение</span>
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="size-8 shrink-0"
                    disabled={busy}
                    title="Ещё"
                  >
                    <MoreHorizontalIcon className="size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="end"
                  className="w-auto min-w-[11rem] p-1"
                  onOpenAutoFocus={(e) => e.preventDefault()}
                >
                  <FloatingMenuItem onClick={onCopyId}>
                    <CopyIcon className="size-3.5" />
                    Копировать ID
                  </FloatingMenuItem>
                  <FloatingMenuItem onClick={onBlock}>
                    <BanIcon className="size-3.5" />
                    Заблокировать
                  </FloatingMenuItem>
                </PopoverContent>
              </Popover>
            </>
          )}
        </div>

        <div className="mt-4 border-t border-border/50" />

        {/* Bio */}
        {profileBio ? (
          <div className="mt-4">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Обо мне
            </p>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
              {profileBio}
            </p>
          </div>
        ) : null}

        {/* Member since (server context) */}
        {showServerSection && member?.joined_at ? (
          <div className="mt-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              На сервере с
            </p>
            <p className="text-sm text-foreground/90">{formatDate(member.joined_at)}</p>
          </div>
        ) : null}

        {/* Roles (server context) */}
        {showServerSection && server && member && (roles.length > 0 || canEditRoles) ? (
          <div className="mt-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Роли
            </p>
            <div className="flex flex-wrap gap-1.5">
              {roles.map((role) => {
                const serverRole = server.roles?.[role.id]
                const canRemove =
                  Boolean(serverRole) &&
                  Boolean(actorUserId) &&
                  canToggleMemberRole(
                    server,
                    actorMember,
                    actorUserId,
                    member,
                    serverRole!,
                    false,
                  )
                const removing = removingRoleId === role.id
                return (
                  <span
                    key={role.id}
                    className={cn(
                      'inline-flex max-w-full items-center gap-1 rounded-md bg-background/60 py-0.5 text-xs font-medium text-foreground',
                      canRemove ? 'pl-2 pr-0.5' : 'px-2',
                    )}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={roleDotStyle(role.colour)}
                    />
                    <span className="truncate">{role.name}</span>
                    {canRemove ? (
                      <button
                        type="button"
                        disabled={removingRoleId !== null}
                        className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                        title={`Убрать «${role.name}»`}
                        onClick={(e) => { e.stopPropagation(); void removeRole(role.id) }}
                      >
                        <XIcon className={cn('size-3', removing && 'opacity-50')} />
                      </button>
                    ) : null}
                  </span>
                )
              })}
              {canEditRoles ? (
                <button
                  type="button"
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-background/60 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title="Изменить роли"
                  onClick={(e) => { e.stopPropagation(); setRolesDialogOpen(true) }}
                >
                  <PlusIcon className="size-3.5" />
                </button>
              ) : null}
            </div>
            {canEditRoles ? (
              <EditMemberRolesDialog
                server={server}
                targetMember={member}
                targetUser={user}
                open={rolesDialogOpen}
                onOpenChange={setRolesDialogOpen}
              />
            ) : null}
          </div>
        ) : null}
        </div>{/* end content */}
      </div>{/* end inner card */}
    </div>
  )
}
