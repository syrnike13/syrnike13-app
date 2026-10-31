import { useNavigate } from '@tanstack/react-router'
import { Effect } from 'effect'
import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { XIcon } from '#/components/icons'

import { UserBlockDialog } from '#/components/user/user-block-dialog'
import { UserGlobalProfileSections } from '#/components/user/user-global-profile-sections'
import { UserGlobalProfileSidebar } from '#/components/user/user-global-profile-sidebar'
import { useUserMutuals } from '#/components/user/use-user-mutuals'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { useAuth } from '#/features/auth/auth-context'
import { openDirectMessageChannel } from '#/features/dm/dm-actions'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import {
  blockUserRelationship,
  unblockBlockedUser,
} from '#/features/friends/friend-actions'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { listServerChannels } from '@syrnike13/client/sync/selectors'
import { useMutualServerMembersSync } from '#/features/sync/mutual-server-members-sync'
import { syncStore } from '@syrnike13/client/sync/sync-store'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { canMessageUser } from '#/features/authorization/authorization'

type UserGlobalProfileDialogProps = {
  user: User
  /** Если задан, показываем серверный контекст (роли, дата входа) */
  serverId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function UserGlobalProfileDialog({
  user,
  serverId,
  open,
  onOpenChange,
}: UserGlobalProfileDialogProps) {
  const t = useTranslations('users')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const { openSettings } = useSettingsModal()
  const [busy, setBusy] = useState(false)
  const [blockOpen, setBlockOpen] = useState(false)

  const isSelf = user._id === auth.user?._id
  const canDirectMessage = !isSelf && !user.bot && canMessageUser(user._id)
  useMutualServerMembersSync(
    user._id,
    auth.user?._id,
    auth.session?.token,
    open,
  )
  const { mutualServers, mutualFriends, mutualFriendsCount } = useUserMutuals(
    user._id,
    { enabled: open },
  )

  const displayName = user.display_name ?? user.username

  function close() {
    onOpenChange(false)
  }

  async function openDm() {
    const token = auth.session?.token
    if (!token || !canDirectMessage) return
    setBusy(true)
    try {
      await Effect.runPromise(
        openDirectMessageChannel(
          token,
          user._id,
          (channelId) => {
            close()
            return navigate({
              to: `${prefix}/c/$channelId`,
              params: { channelId },
              search: { m: undefined },
            })
          },
        ),
      )
    } catch {
      // dm-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  async function handleBlock() {
    const token = auth.session?.token
    if (!token || isSelf) return
    setBusy(true)
    try {
      await Effect.runPromise(blockUserRelationship(token, user._id))
      setBlockOpen(false)
      close()
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
      await Effect.runPromise(unblockBlockedUser(token, user._id))
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  async function copyUserId() {
    try {
      await Effect.runPromise(writeClipboardTextEffect(user._id))
    } catch {
    }
  }

  function handleServerSelect(serverId: string) {
    const channelId = listServerChannels(
      syncStore.getState(),
      serverId,
      auth.user?._id,
    )[0]?._id
    if (!channelId) return
    close()
    void navigate({
      to: `${prefix}/c/$channelId`,
      params: { channelId },
      search: { m: undefined },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-profile-dialog max-h-dialog w-profile-dialog flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {t('profileTitle', { name: displayName })}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t('profileDescription', { name: displayName })}
        </DialogDescription>

        <DialogClose
          render={
            <Button
              type="button"
              variant="secondary"
              size="icon"
              shape="circle"
              className="absolute top-3 right-3 z-30"
            />
          }
        >
          <XIcon />
          <span className="sr-only">{t('close')}</span>
        </DialogClose>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:flex-row sm:gap-0 sm:overflow-hidden sm:p-8">
          <aside className="flex min-h-0 w-full shrink-0 flex-col sm:h-full sm:w-100">
            <UserGlobalProfileSidebar
              user={user}
              serverId={serverId}
              isSelf={isSelf}
              busy={busy}
              onOpenDm={() => void openDm()}
              onCopyId={() => void copyUserId()}
              onBlock={() => setBlockOpen(true)}
              onUnblock={() => void handleUnblock()}
              onEditProfile={() => {
                close()
                openSettings('profile')
              }}
            />
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:h-full sm:pt-5 sm:pl-8">
            <UserGlobalProfileSections
              mutualServers={mutualServers}
              mutualFriends={mutualFriends}
              mutualFriendsCount={mutualFriendsCount}
              busy={busy}
              onServerSelect={handleServerSelect}
            />
          </div>
        </div>

        <UserBlockDialog
          user={user}
          open={blockOpen}
          busy={busy}
          onOpenChange={setBlockOpen}
          onConfirm={() => void handleBlock()}
        />
      </DialogContent>
    </Dialog>
  )
}
