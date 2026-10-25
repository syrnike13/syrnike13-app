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
import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'
import { useTranslations } from '@syrnike13/ui/i18n'

import { UserBlockDialog } from '#/components/user/user-block-dialog'
import {
  ProfileBody,
  ProfileHeader,
  ProfileName,
  ProfileSurface,
} from '#/components/user/profile/profile-parts'
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'
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

  const { bio } = useUserProfileData(profile._id)
  const { mutualFriends, mutualFriendsCount, mutualServersCount } =
    useUserMutuals(profile._id)

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
          variant="overlay"
          size="icon"
          shape="circle"
          disabled={busy}
          title={t('addFriend')}
          aria-label={t('addFriend')}
          onClick={(event) => {
            event.stopPropagation()
            void handleAddFriend()
          }}
        >
          {busy ? <Spinner /> : <UserPlusIcon />}
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
    <ProfileSurface
      surface="popover"
      className="max-h-profile-popover overflow-y-auto"
    >
      <ProfileHeader
        user={profile}
        actions={bannerActions}
        onAvatarClick={canViewProfile ? handleViewProfile : undefined}
      />

      <ProfileBody>
        <div className="flex flex-col gap-2">
          <ProfileName user={profile} />
          <UserProfileMutuals
            mutualFriends={mutualFriends}
            mutualFriendsCount={mutualFriendsCount}
            mutualServersCount={mutualServersCount}
          />
        </div>

        {bio ? (
          <div className="flex min-w-0 flex-col items-start gap-1">
            <p className="line-clamp-3 text-sm leading-4.5 whitespace-pre-wrap text-foreground">
              {bio}
            </p>
            {canViewProfile ? (
              <p className="text-xs">
                <Button
                  type="button"
                  variant="link"
                  size="inline"
                  className="text-muted-foreground"
                  onClick={handleViewProfile}
                >
                  {t('viewFullProfile')}
                </Button>
              </p>
            ) : null}
          </div>
        ) : null}

        <UserProfileRoleList
          user={profile}
          serverId={serverId}
          roles={roles}
          maxVisible={6}
        />

        {isSelf ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              dismiss()
              openSettings('profile')
            }}
          >
            <PencilFillIcon />
            {t('editProfile')}
          </Button>
        ) : canMessage ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void openDm(messageDraft)
            }}
          >
            <InputGroup>
              <InputGroupInput
                value={messageDraft}
                disabled={busy}
                placeholder={t('messagePlaceholder', {
                  username: profile.username,
                })}
                onChange={(event) => setMessageDraft(event.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  type="submit"
                  size="icon-xs"
                  disabled={busy}
                  title={t('openDm')}
                  aria-label={t('openDm')}
                >
                  {busy ? <Spinner /> : <MessageCircleIcon />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
        ) : null}
      </ProfileBody>

      <UserBlockDialog
        user={profile}
        open={blockOpen}
        busy={busy}
        onOpenChange={setBlockOpen}
        onConfirm={() => void handleBlock()}
      />
    </ProfileSurface>
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
            variant="overlay"
            size="icon"
            shape="circle"
            disabled={disabled}
            title={t('more')}
            aria-label={t('profileActions')}
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        className="z-220 w-auto min-w-48"
      >
        {canViewProfile ? (
          <DropdownMenuItem onClick={onViewProfile}>
            <UserIcon />
            {t('viewProfile')}
          </DropdownMenuItem>
        ) : null}
        {canAddFriend ? (
          <DropdownMenuItem onClick={onAddFriend}>
            <UserPlusIcon />
            {t('addFriend')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onCopyUsername}>
          <CopyIcon />
          {t('copyUsername')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCopyUserId}>
          <CopyIcon />
          {t('copyUserId')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {isBlocked ? (
          <DropdownMenuItem onClick={onUnblock}>
            <UserCheckIcon />
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
  )
}
