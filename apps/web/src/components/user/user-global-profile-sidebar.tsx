import { useQuery } from '@tanstack/react-query'
import {
  BanIcon,
  CopyIcon,
  Loader2Icon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SettingsIcon,
  UserCheckIcon,
  UserPlusIcon,
  XIcon,
} from '#/components/icons'
import { useMemo, useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { EditMemberRolesDialog } from '#/components/servers/edit-member-roles-dialog'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserMusicPresenceCard } from '#/components/user/user-music-presence-card'
import { UserBadges } from '#/components/user/user-badges'
import { UserProfileStatusBubble } from '#/components/user/user-profile-status-bubble'
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
import {
  acceptIncomingFriendRequest,
  cancelOutgoingFriendRequest,
  declineIncomingFriendRequest,
  sendFriendRequestToUser,
} from '#/features/friends/friend-actions'
import { queryKeys } from '#/lib/api/query-keys'
import { userBannerUrl } from '#/lib/media'
import { userProfileBannerClassName } from '#/lib/user-profile-banner'
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

const profileIconActionClass =
  'size-8 shrink-0 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground'

const profilePrimaryActionClass =
  'w-fit gap-1.5 transition-colors hover:bg-primary/85 active:bg-primary/75'

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
  const canDirectMessage = !isSelf && !user.bot

  const [rolesDialogOpen, setRolesDialogOpen] = useState(false)
  const [removingRoleId, setRemovingRoleId] = useState<string | null>(null)
  const [friendBusy, setFriendBusy] = useState(false)
  const actionsDisabled = busy || friendBusy || !token

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

  const bannerUrl = userBannerUrl(profileQuery.data?.background, {
    animated: true,
  })
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

  async function runFriendAction(action: () => Promise<unknown>) {
    if (!token || actionsDisabled) return
    setFriendBusy(true)
    try {
      await action()
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setFriendBusy(false)
    }
  }

  const showAddFriend = canDirectMessage && user.relationship === 'None'
  const showAcceptFriend = canDirectMessage && user.relationship === 'Incoming'
  const isFriend = user.relationship === 'Friend'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-6">
      {/* Inner card */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-secondary ">
        {/* Banner */}
        <div className="relative shrink-0">
          <div
            className={userProfileBannerClassName(
              'rounded-t-xl',
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
            <UserProfileStatusBubble
              status={customStatus}
              className="left-full top-[43%] ml-2"
            />
            <UserAvatar
              user={user}
              className="size-24"
              fallbackClassName="size-24 text-2xl ring-[5px] ring-secondary bg-secondary"
              animated="always"
              showPresence
              presenceRingClassName="border-secondary"
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
        </p>
        <UserBadges badges={user.badges} className="mt-2" />

        {/* Action buttons */}
        <div className="mt-3 flex gap-1.5">
          {isSelf ? (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              className={cn('gap-2', profilePrimaryActionClass)}
              onClick={onEditProfile}
            >
              <SettingsIcon className="size-3.5" />
              Редактировать
            </Button>
          ) : (
            <>
              {showAcceptFriend ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={actionsDisabled}
                  className={profilePrimaryActionClass}
                  onClick={() =>
                    void runFriendAction(() =>
                      acceptIncomingFriendRequest(token!, user._id),
                    )
                  }
                >
                  {friendBusy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <UserCheckIcon className="size-3.5" />
                  )}
                  <span className="truncate">Принять</span>
                </Button>
              ) : null}
              {showAddFriend ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={actionsDisabled}
                  className={profilePrimaryActionClass}
                  onClick={() =>
                    void runFriendAction(() => sendFriendRequestToUser(token!, user))
                  }
                >
                  {friendBusy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <UserPlusIcon className="size-3.5" />
                  )}
                  <span className="truncate">Добавить в друзья</span>
                </Button>
              ) : null}
              {canDirectMessage ? (
                <Button
                  type="button"
                  variant={isFriend ? 'default' : 'ghost'}
                  size={isFriend ? 'sm' : 'icon'}
                  disabled={actionsDisabled}
                  className={
                    isFriend ? profilePrimaryActionClass : profileIconActionClass
                  }
                  title="Сообщение"
                  aria-label="Сообщение"
                  onClick={onOpenDm}
                >
                  {busy ? (
                    <Loader2Icon
                      className={cn('animate-spin', isFriend ? 'size-3.5' : 'size-4')}
                    />
                  ) : (
                    <MessageCircleIcon className={isFriend ? 'size-3.5' : 'size-4'} />
                  )}
                  {isFriend ? <span className="truncate">Сообщение</span> : null}
                </Button>
              ) : null}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={profileIconActionClass}
                    disabled={actionsDisabled}
                    title="Ещё"
                    aria-label="Ещё"
                  >
                    <MoreHorizontalIcon className="size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="end"
                  className="z-[310] w-auto min-w-[11rem] p-1"
                  onOpenAutoFocus={(e) => e.preventDefault()}
                >
                  {user.relationship === 'Incoming' ? (
                    <FloatingMenuItem
                      onClick={() =>
                        void runFriendAction(() =>
                          declineIncomingFriendRequest(token!, user._id),
                        )
                      }
                    >
                      <XIcon className="size-3.5" />
                      Отклонить заявку
                    </FloatingMenuItem>
                  ) : null}
                  {user.relationship === 'Outgoing' ? (
                    <FloatingMenuItem
                      onClick={() =>
                        void runFriendAction(() =>
                          cancelOutgoingFriendRequest(token!, user._id),
                        )
                      }
                    >
                      <XIcon className="size-3.5" />
                      Отменить заявку
                    </FloatingMenuItem>
                  ) : null}
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

        <UserMusicPresenceCard userId={user._id} className="mt-4" />

        {/* Bio */}
        {profileBio ? (
          <div className="mt-4">
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
