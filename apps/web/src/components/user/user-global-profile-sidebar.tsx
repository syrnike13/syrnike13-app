import { Effect } from 'effect'
import {
  BanIcon,
  CopyIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  ServerIcon,
  SettingsIcon,
  UserCheckIcon,
  UserPlusIcon,
  XIcon,
} from '#/components/icons'
import type { User } from '@syrnike13/api-types'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'

import { UserProfileHeader } from '#/components/user/user-profile-header'
import { UserProfileIdentity } from '#/components/user/user-profile-identity'
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
    month: 'long',
    year: 'numeric',
  })
}

const profileIconActionClass = 'size-8 shrink-0 text-muted-foreground'

/**
 * Левая карточка полного профиля Discord: 400px, баннер 140px,
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
  const tf = useTranslations('friends')
  const { locale } = useLocale()
  const auth = useAuth()
  const token = auth.session?.token
  const { bio } = useUserProfileData(user._id)
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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-secondary sm:rounded-t-xl">
      <UserProfileHeader user={user} variant="modal" />

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 pt-1 pr-6 pb-8">
        <UserProfileIdentity user={user} variant="modal" />

        <div className="flex flex-wrap items-center gap-2">
          {isSelf ? (
            <Button
              type="button"
              size="default"
              disabled={busy}
              className="h-8 gap-1.5"
              onClick={onEditProfile}
            >
              <SettingsIcon className="size-4" />
              {t('editProfile')}
            </Button>
          ) : (
            <>
              {showAcceptFriend ? (
                <Button
                  type="button"
                  size="default"
                  disabled={actionsDisabled}
                  className="h-8 gap-1.5"
                  onClick={() =>
                    void runFriendAction(() =>
                      acceptIncomingFriendRequest(token!, user._id, tf),
                    )
                  }
                >
                  <UserCheckIcon className="size-4" />
                  <span className="truncate">{t('accept')}</span>
                </Button>
              ) : null}
              {canDirectMessage ? (
                <Button
                  type="button"
                  variant={showAcceptFriend ? 'secondary' : 'default'}
                  size="default"
                  disabled={actionsDisabled}
                  className="h-8 gap-1.5"
                  onClick={onOpenDm}
                >
                  {busy ? (
                    <Spinner className="size-4" />
                  ) : (
                    <MessageCircleIcon className="size-4" />
                  )}
                  <span className="truncate">{t('message')}</span>
                </Button>
              ) : showAddFriend ? (
                <Button
                  type="button"
                  size="default"
                  disabled={actionsDisabled}
                  className="h-8 gap-1.5"
                  onClick={() =>
                    void runFriendAction(() =>
                      sendFriendRequestToUser(token!, user, tf),
                    )
                  }
                >
                  <UserPlusIcon className="size-4" />
                  <span className="truncate">{t('addFriend')}</span>
                </Button>
              ) : null}
              {showAddFriend && canDirectMessage ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={actionsDisabled}
                  className={profileIconActionClass}
                  title={t('addFriend')}
                  aria-label={t('addFriend')}
                  onClick={() =>
                    void runFriendAction(() =>
                      sendFriendRequestToUser(token!, user, tf),
                    )
                  }
                >
                  <UserPlusIcon className="size-4" />
                </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={profileIconActionClass}
                      disabled={actionsDisabled}
                      title={t('more')}
                      aria-label={t('more')}
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-4" />
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
                          declineIncomingFriendRequest(token!, user._id, tf),
                        )
                      }
                    >
                      <XIcon className="size-3.5" />
                      {t('declineRequest')}
                    </DropdownMenuItem>
                  ) : null}
                  {user.relationship === 'Outgoing' ? (
                    <DropdownMenuItem
                      onClick={() =>
                        void runFriendAction(() =>
                          cancelOutgoingFriendRequest(token!, user._id, tf),
                        )
                      }
                    >
                      <XIcon className="size-3.5" />
                      {t('cancelRequest')}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onClick={onCopyId}>
                    <CopyIcon className="size-3.5" />
                    {t('copyId')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {user.relationship === 'Blocked' ? (
                    <DropdownMenuItem onClick={onUnblock}>
                      <BanIcon className="size-3.5" />
                      {t('unblock')}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem variant="destructive" onClick={onBlock}>
                      <BanIcon className="size-3.5" />
                      {t('block')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>

        {bio ? (
          <p className="text-sm leading-4.5 whitespace-pre-wrap text-foreground">
            {bio}
          </p>
        ) : null}

        {server && member?.joined_at ? (
          <section>
            <h3 className="text-xs leading-4 font-medium text-muted-foreground">
              {t('memberSince')}
            </h3>
            <p className="mt-2 flex min-w-0 items-center gap-1.5 text-sm leading-4.5 text-foreground">
              <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{server.name}</span>
              <span aria-hidden className="size-1 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="shrink-0 text-muted-foreground">
                {formatDate(member.joined_at, locale)}
              </span>
            </p>
          </section>
        ) : null}

        <UserProfileRoleList user={user} serverId={serverId} heading />
      </div>
    </div>
  )
}
