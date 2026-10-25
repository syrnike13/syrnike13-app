import { Effect } from 'effect'
import {
  BanIcon,
  CopyIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  ServerIcon,
  PencilFillIcon,
  UserCheckIcon,
  UserPlusIcon,
  XIcon,
} from '#/components/icons'
import type { User } from '@syrnike13/api-types'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'

import {
  ProfileBody,
  ProfileHeader,
  ProfileName,
  ProfileSection,
  ProfileSurface,
} from '#/components/user/profile/profile-parts'
import { UserProfileRoleList } from '#/components/user/user-profile-role-list'
import { useUserProfileData } from '#/components/user/use-user-profile-data'
import { Button } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { useAuth } from '#/features/auth/auth-context'
import {
  acceptIncomingFriendRequest,
  cancelOutgoingFriendRequest,
  declineIncomingFriendRequest,
  sendFriendRequestToUser,
} from '#/features/friends/friend-actions'
import { useSyncStore } from '#/features/sync/sync-store'
import { canMessageUser } from '#/features/authorization/authorization'
import { ulidToDate } from '#/lib/ulid'

type UserGlobalProfileSidebarProps = {
  user: User
  serverId?: string
  isSelf: boolean
  busy: boolean
  onOpenDm: () => void
  onCopyId: () => void
  onBlock: () => void
  onUnblock: () => void
  onEditProfile: () => void
}

function formatDate(iso: string, locale: string) {
  return new Date(iso).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Левая карточка полного профиля: 400px, баннер 140px,
 * аватар 120px, имя 24/32 w600, секции 12/16 w500.
 */
export function UserGlobalProfileSidebar({
  user,
  serverId,
  isSelf,
  busy,
  onOpenDm,
  onCopyId,
  onBlock,
  onUnblock,
  onEditProfile,
}: UserGlobalProfileSidebarProps) {
  const t = useTranslations('users')
  const { locale } = useLocale()
  const auth = useAuth()
  const token = auth.session?.token
  const { bio, colours } = useUserProfileData(user._id)
  const canDirectMessage = !isSelf && !user.bot && canMessageUser(user._id)

  const server = useSyncStore((state) =>
    serverId ? state.servers[serverId] : undefined,
  )
  const member = useSyncStore((state) =>
    serverId ? state.members[`${serverId}:${user._id}`] : undefined,
  )

  const showAddFriend = canDirectMessage && user.relationship === 'None'
  const showAcceptFriend = canDirectMessage && user.relationship === 'Incoming'
  const actionsDisabled = busy || !token

  async function runFriendAction(
    action: () => Effect.Effect<unknown, unknown>,
  ) {
    if (!token || actionsDisabled) return
    await Effect.runPromise(action()).catch(() => {
      // friend-actions already shows the concrete error toast.
    })
  }

  const memberSince = ulidToDate(user._id).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

  return (
    <ProfileSurface
      colours={colours}
      size="lg"
      surface="secondary"
      className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-secondary"
    >
      <ProfileHeader user={user} />

      <ProfileBody>
        <ProfileName user={user} />

        <div className="flex flex-wrap items-center gap-2">
          {isSelf ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onEditProfile}
            >
              <PencilFillIcon />
              {t('editProfile')}
            </Button>
          ) : (
            <>
              {showAcceptFriend ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={actionsDisabled}
                  onClick={() =>
                    void runFriendAction(() =>
                      acceptIncomingFriendRequest(token!, user._id),
                    )
                  }
                >
                  <UserCheckIcon />
                  {t('accept')}
                </Button>
              ) : null}
              {canDirectMessage ? (
                <Button
                  type="button"
                  variant={showAcceptFriend ? 'outline' : 'default'}
                  size="sm"
                  disabled={actionsDisabled}
                  onClick={onOpenDm}
                >
                  {busy ? <Spinner /> : <MessageCircleIcon />}
                  {t('message')}
                </Button>
              ) : null}
              {showAddFriend ? (
                <Button
                  type="button"
                  variant={canDirectMessage ? 'outline' : 'default'}
                  size={canDirectMessage ? 'icon' : 'sm'}
                  disabled={actionsDisabled}
                  title={t('addFriend')}
                  aria-label={t('addFriend')}
                  onClick={() =>
                    void runFriendAction(() =>
                      sendFriendRequestToUser(token!, user),
                    )
                  }
                >
                  <UserPlusIcon />
                  {canDirectMessage ? null : t('addFriend')}
                </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      disabled={actionsDisabled}
                      title={t('more')}
                      aria-label={t('more')}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="bottom"
                  align="start"
                  className="z-310 w-auto min-w-44"
                >
                  {user.relationship === 'Incoming' ? (
                    <DropdownMenuItem
                      onClick={() =>
                        void runFriendAction(() =>
                          declineIncomingFriendRequest(token!, user._id),
                        )
                      }
                    >
                      <XIcon />
                      {t('declineRequest')}
                    </DropdownMenuItem>
                  ) : null}
                  {user.relationship === 'Outgoing' ? (
                    <DropdownMenuItem
                      onClick={() =>
                        void runFriendAction(() =>
                          cancelOutgoingFriendRequest(token!, user._id),
                        )
                      }
                    >
                      <XIcon />
                      {t('cancelRequest')}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onClick={onCopyId}>
                    <CopyIcon />
                    {t('copyId')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {user.relationship === 'Blocked' ? (
                    <DropdownMenuItem onClick={onUnblock}>
                      <BanIcon />
                      {t('unblock')}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem variant="destructive" onClick={onBlock}>
                      <BanIcon />
                      {t('block')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>

        {bio ? (
          <ProfileSection title={t('aboutMe')}>
            <p className="whitespace-pre-wrap">{bio}</p>
          </ProfileSection>
        ) : null}

        <ProfileSection title={t('accountCreated')}>
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>{memberSince}</span>
            {server && member?.joined_at ? (
              <>
                <span aria-hidden className="text-muted-foreground">
                  •
                </span>
                <span
                  className="flex min-w-0 items-center gap-1.5"
                  title={t('memberSince')}
                >
                  <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{server.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {formatDate(member.joined_at, locale)}
                  </span>
                </span>
              </>
            ) : null}
          </p>
        </ProfileSection>

        <UserProfileRoleList user={user} serverId={serverId} title={t('roles')} />
      </ProfileBody>
    </ProfileSurface>
  )
}
