// design-allow-file restyle-shared: the profile skeleton mirrors the card's banner, avatar, pills and text lines
import { useNavigate } from '@tanstack/react-router'
import { Effect } from 'effect'
import {
  BanIcon,
  CopyIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PencilFillIcon,
  UserCheckIcon,
  UserIcon,
  UserPlusIcon,
} from '#/components/icons'
import { useCallback, useEffect, useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Skeleton } from '@syrnike13/ui/primitives/skeleton'

import { UserBlockDialog } from '#/components/user/user-block-dialog'
import { UserProfileHeader } from '#/components/user/user-profile-header'
import { UserProfileIdentity } from '#/components/user/user-profile-identity'
import { UserProfileMutuals } from '#/components/user/user-profile-mutuals'
import { UserProfileRoleList } from '#/components/user/user-profile-role-list'
import { useUserMutuals } from '#/components/user/use-user-mutuals'
import { useUserProfileData } from '#/components/user/use-user-profile-data'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { Input } from '@syrnike13/ui/primitives/input'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { useAuth } from '#/features/auth/auth-context'
import { openDirectMessageChannel } from '#/features/dm/dm-actions'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import {
  blockUserRelationship,
  sendFriendRequestToUser,
  unblockBlockedUser,
} from '#/features/friends/friend-actions'
import type { MemberRoleEntry } from '#/features/sync/selectors'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { cn } from '#/lib/utils'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import {
  canMessageUser,
  canViewUserProfile,
} from '#/features/authorization/authorization'

export type UserProfileCardProps = {
  user: User
  hideMessage?: boolean
  serverId?: string
  serverName?: string
  roles?: MemberRoleEntry[]
  onClose?: () => void
  onOpenGlobalProfile?: () => void
}

function UserProfileCardSkeleton() {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col gap-2 overflow-hidden bg-popover"
      aria-hidden="true"
    >
      <div className="relative h-38 shrink-0">
        <Skeleton className="h-26.25 w-full rounded-none" />
        <Skeleton className="absolute top-15.25 left-4 size-20 rounded-full ring-6 ring-popover" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-1 pb-3">
        <div className="space-y-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
        <div className="mt-1 space-y-2">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      </div>
    </div>
  )
}

/**
 * Серверный профиль в поповере (ЛКМ по участнику). Геометрия:
 * 300px, баннер 105px, аватар 80px, имя 20/24 w600, роли 24px.
 */
export function UserProfileCard({
  user: profile,
  hideMessage,
  serverId,
  roles,
  onClose,
  onOpenGlobalProfile,
}: UserProfileCardProps) {
  const t = useTranslations('users')
  const tf = useTranslations('friends')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const { openSettings } = useSettingsModal()

  const [busy, setBusy] = useState(false)
  const [blockOpen, setBlockOpen] = useState(false)
  const [messageDraft, setMessageDraft] = useState('')
  const [headerLoading, setHeaderLoading] = useState(true)

  const { bio, isPending } = useUserProfileData(profile._id)
  const {
    mutualFriends,
    mutualFriendsCount,
    mutualServersCount,
    loading: mutualsLoading,
  } = useUserMutuals(profile._id)

  const handleHeaderLoadingChange = useCallback(
    (loading: boolean) => setHeaderLoading(loading),
    [],
  )
  const loading = isPending || headerLoading || mutualsLoading

  useEffect(() => {
    if (!loading) return
    const timer = window.setTimeout(() => setHeaderLoading(false), 10_000)
    return () => window.clearTimeout(timer)
  }, [loading])

  const isSelf = profile._id === auth.user?._id
  const canMessage =
    !hideMessage && !isSelf && !profile.bot && canMessageUser(profile._id)
  const canViewProfile =
    Boolean(onOpenGlobalProfile) && canViewUserProfile(profile._id)
  const showBannerMenu = !isSelf && !profile.bot
  const canAddFriend = showBannerMenu && profile.relationship === 'None'
  const isBlocked = profile.relationship === 'Blocked'

  function dismiss() {
    onClose?.()
  }

  function handleViewProfile() {
    if (!onOpenGlobalProfile) return
    dismiss()
    onOpenGlobalProfile()
  }

  async function handleBlock() {
    const token = auth.session?.token
    if (!token || isSelf) return
    setBusy(true)
    try {
      await Effect.runPromise(blockUserRelationship(token, profile._id, tf))
      setBlockOpen(false)
      dismiss()
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  async function handleUnblock() {
    const token = auth.session?.token
    if (!token || isSelf) return
    setBusy(true)
    try {
      await Effect.runPromise(unblockBlockedUser(token, profile._id, tf))
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  async function handleAddFriend() {
    const token = auth.session?.token
    if (!token || !canAddFriend) return
    setBusy(true)
    try {
      await Effect.runPromise(sendFriendRequestToUser(token, profile, tf))
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  async function copyToClipboard(
    value: string,
    successKey: 'idCopied' | 'usernameCopied',
  ) {
    try {
      await Effect.runPromise(writeClipboardTextEffect(value))
      toast.success(t(successKey))
    } catch {
      toast.error(t('copyError'))
    }
  }

  async function openDm(prefill?: string) {
    const token = auth.session?.token
    if (!token || !canMessage) return
    setBusy(true)
    try {
      await Effect.runPromise(
        openDirectMessageChannel(
          token,
          profile._id,
          (channelId) => {
            dismiss()
            setMessageDraft('')
            return navigate({
              to: `${prefix}/c/$channelId`,
              params: { channelId },
              search: { m: undefined },
            })
          },
          t,
        ),
      )
      if (prefill?.trim()) {
        toast.message(t('openChatHint'), {
          description: prefill.trim(),
        })
      }
    } catch {
      // dm-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  const bannerActions = showBannerMenu ? (
    <>
      {canAddFriend ? (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          disabled={busy}
          title={t('addFriend')}
          aria-label={t('addFriend')}
          className="size-8"
          onClick={(event) => {
            event.stopPropagation()
            void handleAddFriend()
          }}
        >
          {busy ? (
            <Spinner className="size-4" />
          ) : (
            <UserPlusIcon className="size-4" />
          )}
        </Button>
      ) : null}
      {canMessage ? (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          disabled={busy}
          title={t('message')}
          aria-label={t('message')}
          className="size-8"
          onClick={(event) => {
            event.stopPropagation()
            void openDm()
          }}
        >
          <MessageCircleIcon className="size-4" />
        </Button>
      ) : null}
      <UserProfileCardBannerMenu
        disabled={busy}
        canViewProfile={canViewProfile}
        canAddFriend={canAddFriend}
        isBlocked={isBlocked}
        onViewProfile={handleViewProfile}
        onAddFriend={() => void handleAddFriend()}
        onBlock={() => setBlockOpen(true)}
        onUnblock={() => void handleUnblock()}
        onCopyUsername={() =>
          void copyToClipboard(profile.username, 'usernameCopied')
        }
        onCopyUserId={() => void copyToClipboard(profile._id, 'idCopied')}
      />
    </>
  ) : undefined

  return (
    <div className="relative min-w-0">
      <div
        className={cn(
          'flex max-h-profile-popover min-w-0 flex-col gap-2',
          loading && 'pointer-events-none opacity-0',
        )}
        aria-busy={loading || undefined}
        inert={loading}
      >
        <UserProfileHeader
          user={profile}
          variant="popover"
          bannerActions={bannerActions}
          onAvatarClick={canViewProfile ? handleViewProfile : undefined}
          onMediaLoadingChange={handleHeaderLoadingChange}
        />

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pt-1 pb-2">
          <UserProfileIdentity user={profile} />
          <UserProfileMutuals
            mutualFriends={mutualFriends}
            mutualFriendsCount={mutualFriendsCount}
            mutualServersCount={mutualServersCount}
          />
          {bio ? (
            <div className="min-w-0">
              <p className="line-clamp-3 text-sm leading-4.5 whitespace-pre-wrap text-foreground">
                {bio}
              </p>
              {canViewProfile ? (
                <button
                  type="button"
                  className="mt-1 text-xs leading-4 text-muted-foreground transition-colors hover:text-foreground hover:underline"
                  onClick={handleViewProfile}
                >
                  {t('viewFullProfile')}
                </button>
              ) : null}
            </div>
          ) : null}
          <UserProfileRoleList
            user={profile}
            serverId={serverId}
            roles={roles}
            maxVisible={6}
          />
        </div>

        {isSelf ? (
          <div className="px-4 pb-3">
            <Button
              type="button"
              size="default"
              className="h-8 w-full"
              onClick={() => {
                dismiss()
                openSettings('profile')
              }}
            >
              <PencilFillIcon className="size-4" aria-hidden />
              {t('editProfile')}
            </Button>
          </div>
        ) : canMessage ? (
          <form
            className="px-4 pb-3"
            onSubmit={(event) => {
              event.preventDefault()
              void openDm(messageDraft)
            }}
          >
            <div className="relative">
              <Input
                value={messageDraft}
                disabled={busy}
                placeholder={t('messagePlaceholder', {
                  username: profile.username,
                })}
                className="h-11.5 pr-11 text-base leading-5.5 md:text-base"
                onChange={(event) => setMessageDraft(event.target.value)}
              />
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                disabled={busy}
                className="absolute top-1/2 right-1.5 size-8 -translate-y-1/2"
                title={t('openDm')}
                aria-label={t('openDm')}
              >
                {busy ? (
                  <Spinner className="size-4" />
                ) : (
                  <MessageCircleIcon className="size-4" />
                )}
              </Button>
            </div>
          </form>
        ) : null}

        <UserBlockDialog
          user={profile}
          open={blockOpen}
          busy={busy}
          onOpenChange={setBlockOpen}
          onConfirm={() => void handleBlock()}
        />
      </div>
      {loading ? <UserProfileCardSkeleton /> : null}
    </div>
  )
}

function UserProfileCardBannerMenu({
  disabled,
  canViewProfile,
  canAddFriend,
  isBlocked,
  onViewProfile,
  onAddFriend,
  onBlock,
  onUnblock,
  onCopyUsername,
  onCopyUserId,
}: {
  disabled?: boolean
  canViewProfile: boolean
  canAddFriend: boolean
  isBlocked: boolean
  onViewProfile: () => void
  onAddFriend: () => void
  onBlock: () => void
  onUnblock: () => void
  onCopyUsername: () => void
  onCopyUserId: () => void
}) {
  const t = useTranslations('users')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="icon"
            disabled={disabled}
            title={t('more')}
            aria-label={t('profileActions')}
            className="size-8"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <MoreHorizontalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        className="z-220 w-auto min-w-48"
      >
        {canViewProfile ? (
          <DropdownMenuItem onClick={onViewProfile}>
            <UserIcon className="size-3.5" />
            {t('viewProfile')}
          </DropdownMenuItem>
        ) : null}
        {canAddFriend ? (
          <DropdownMenuItem onClick={onAddFriend}>
            <UserPlusIcon className="size-3.5" />
            {t('addFriend')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onCopyUsername}>
          <CopyIcon className="size-3.5" />
          {t('copyUsername')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCopyUserId}>
          <CopyIcon className="size-3.5" />
          {t('copyUserId')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {isBlocked ? (
          <DropdownMenuItem onClick={onUnblock}>
            <UserCheckIcon className="size-3.5" />
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
  )
}
