import { useNavigate } from '@tanstack/react-router'
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

import { UserProfileCardHeader } from '#/components/user/user-profile-card-header'
import { Button } from '#/components/ui/button'
import { FloatingMenuItem } from '#/components/ui/floating-menu'
import { Input } from '#/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { useAuth } from '#/features/auth/auth-context'
import { openDirectMessageChannel } from '#/features/dm/dm-actions'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { blockUserRelationship, sendFriendRequestToUser } from '#/features/friends/friend-actions'
import type { MemberRoleEntry } from '#/features/sync/selectors'
import { writeClipboardText } from '#/lib/clipboard'
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
    if (!window.confirm(`Заблокировать @${profile.username}?`)) return
    setBusy(true)
    try {
      await blockUserRelationship(token, profile._id)
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
      await sendFriendRequestToUser(token, profile)
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  async function copyUserId() {
    try {
      await writeClipboardText(profile._id)
      toast.success('ID скопирован')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  async function openDm(prefill?: string) {
    const token = auth.session?.token
    if (!token || !canMessage) return
    setBusy(true)
    try {
      await openDirectMessageChannel(token, profile._id, (channelId) => {
        dismiss()
        setMessageDraft('')
        return navigate({
          to: `${prefix}/c/$channelId`,
          params: { channelId },
          search: { m: undefined },
        })
      })
      if (prefill?.trim()) {
        toast.message('Откройте чат и отправьте сообщение', {
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
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  title="Добавить в друзья"
                  aria-label="Добавить в друзья"
                  className="size-8 rounded-full bg-black/45 text-white shadow-sm backdrop-blur-sm hover:bg-black/60 hover:text-white"
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
              placeholder={`Сообщение @${profile.username}`}
              className="h-10 rounded-lg border-border bg-secondary pr-10 text-sm text-secondary-foreground shadow-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-accent dark:text-accent-foreground"
              onChange={(event) => setMessageDraft(event.target.value)}
            />
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              disabled={busy}
              className="absolute top-1/2 right-1.5 size-8 -translate-y-1/2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title="Открыть ЛС"
              aria-label="Открыть ЛС"
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
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          title="Ещё"
          aria-label="Действия профиля"
          className="size-8 rounded-full bg-black/45 text-white shadow-sm backdrop-blur-sm hover:bg-black/60 hover:text-white"
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
            Посмотреть профиль
          </FloatingMenuItem>
        ) : null}
        <FloatingMenuItem onClick={onBlock} destructive>
          <BanIcon className="size-3.5" />
          Заблокировать
        </FloatingMenuItem>
        <FloatingMenuItem onClick={onCopyUserId}>
          <CopyIcon className="size-3.5" />
          Копировать user ID
        </FloatingMenuItem>
      </PopoverContent>
    </Popover>
  )
}
