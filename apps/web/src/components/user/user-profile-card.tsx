import { useNavigate } from '@tanstack/react-router'
import { Effect } from 'effect'
import {
  BanIcon,
  CopyIcon,
  Loader2Icon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  UserIcon,
  UserPlusIcon,
} from '#/components/icons'
import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'
import { useTranslations } from '@syrnike13/ui/i18n'

import { UserProfileCardHeader } from '#/components/user/user-profile-card-header'
import { Button } from '@syrnike13/ui/primitives/button'
import { FloatingMenuItem } from '@syrnike13/ui/primitives/floating-menu'
import { Input } from '@syrnike13/ui/primitives/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { useAuth } from '#/features/auth/auth-context'
import { openDirectMessageChannel } from '#/features/dm/dm-actions'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { blockUserRelationship, sendFriendRequestToUser } from '#/features/friends/friend-actions'
import type { MemberRoleEntry } from '#/features/sync/selectors'
import { writeClipboardTextEffect } from '#/lib/clipboard'
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

/** Серверный профиль в поповере (ЛКМ по участнику). */
export function UserProfileCard({
  user: profile,
  hideMessage,
  serverId,
  serverName: serverNameProp,
  roles: rolesProp,
  onClose,
  onOpenGlobalProfile,
}: UserProfileCardProps) {
  const t = useTranslations('users')
  const tf = useTranslations('friends')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()

  const [busy, setBusy] = useState(false)
  const [messageDraft, setMessageDraft] = useState('')

  const isSelf = profile._id === auth.user?._id
  const canMessage =
    !hideMessage && !isSelf && !profile.bot && canMessageUser(profile._id)
  const showBannerMenu = !isSelf && !profile.bot
  const canAddFriend = showBannerMenu && profile.relationship === 'None'

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
    if (!window.confirm(t('confirmBan', { username: profile.username }))) return
    setBusy(true)
    try {
      await Effect.runPromise(blockUserRelationship(token, profile._id, tf))
      dismiss()
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

  async function copyUserId() {
    try {
      await Effect.runPromise(writeClipboardTextEffect(profile._id))
      toast.success(t('idCopied'))
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

  return (
    <>
      <UserProfileCardHeader
        user={profile}
        serverId={serverId}
        serverName={serverNameProp}
        roles={rolesProp}
        onAvatarClick={
          onOpenGlobalProfile
            ? () => {
                dismiss()
                onOpenGlobalProfile()
              }
            : undefined
        }
        bannerActions={
          showBannerMenu ? (
            <div className="flex items-center gap-1.5">
              {canAddFriend ? (
                <Button
                  type="button"
                  variant="scrim-icon"
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
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <UserPlusIcon className="size-4" />
                  )}
                </Button>
              ) : null}
              <UserProfileCardBannerMenu
                disabled={busy}
                canViewProfile={
                  Boolean(onOpenGlobalProfile) && canViewUserProfile(profile._id)
                }
                onViewProfile={handleViewProfile}
                onBlock={() => void handleBlock()}
                onCopyUserId={() => void copyUserId()}
              />
            </div>
          ) : undefined
        }
      />

      {canMessage ? (
        <form
          className="px-4 pt-1 pb-4"
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
              className="h-10 pr-10 text-sm"
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
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <MessageCircleIcon className="size-4" />
              )}
            </Button>
          </div>
        </form>
      ) : null}
    </>
  )
}

function UserProfileCardBannerMenu({
  disabled,
  canViewProfile,
  onViewProfile,
  onBlock,
  onCopyUserId,
}: {
  disabled?: boolean
  canViewProfile: boolean
  onViewProfile: () => void
  onBlock: () => void
  onCopyUserId: () => void
}) {
  const t = useTranslations('users')

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="scrim-icon"
          size="icon"
          disabled={disabled}
          title={t('more')}
          aria-label={t('profileActions')}
          className="size-8"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="z-[220] w-auto min-w-[12rem] p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {canViewProfile ? (
          <FloatingMenuItem onClick={onViewProfile}>
            <UserIcon className="size-3.5" />
            {t('viewProfile')}
          </FloatingMenuItem>
        ) : null}
        <FloatingMenuItem onClick={onBlock} destructive>
          <BanIcon className="size-3.5" />
          {t('block')}
        </FloatingMenuItem>
        <FloatingMenuItem onClick={onCopyUserId}>
          <CopyIcon className="size-3.5" />
          {t('copyUserId')}
        </FloatingMenuItem>
      </PopoverContent>
    </Popover>
  )
}
