import { useNavigate } from '@tanstack/react-router'
import { Effect } from 'effect'
import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'
import { useTranslations } from '@syrnike13/ui/i18n'

import { UserGlobalProfileSections } from '#/components/user/user-global-profile-sections'
import { UserGlobalProfileSidebar } from '#/components/user/user-global-profile-sidebar'
import {
  Dialog,
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
import { listMutualServers, listServerChannels } from '#/features/sync/selectors'
import { useMutualServerMembersSync } from '#/features/sync/mutual-server-members-sync'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
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
  const tf = useTranslations('friends')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const { openSettings } = useSettingsModal()
  const [busy, setBusy] = useState(false)

  const isSelf = user._id === auth.user?._id
  const canDirectMessage = !isSelf && !user.bot && canMessageUser(user._id)
  useMutualServerMembersSync(
    user._id,
    auth.user?._id,
    auth.session?.token,
    open,
  )
  const mutualServers = useSyncStore((s) =>
    listMutualServers(s, user._id, auth.user?._id),
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
          t,
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
    if (!window.confirm(t('confirmBan', { username: user.username })))
      return
    setBusy(true)
    try {
      await Effect.runPromise(blockUserRelationship(token, user._id, tf))
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
      await Effect.runPromise(unblockBlockedUser(token, user._id, tf))
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  async function copyUserId() {
    try {
      await Effect.runPromise(writeClipboardTextEffect(user._id))
      toast.success(t('idCopied'))
    } catch {
      toast.error(t('copyError'))
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
        className="flex h-[min(41.25rem,90vh)] max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[56.25rem]"
        showCloseButton
      >
        <DialogTitle className="sr-only">
          {t('profileTitle', { name: displayName })}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t('profileDescription', { name: displayName })}
        </DialogDescription>

        <div className="flex min-h-0 flex-1 overflow-hidden p-6">
          <aside className="flex w-1/2 min-w-0 shrink-0 flex-col overflow-hidden">
            <UserGlobalProfileSidebar
              user={user}
              serverId={serverId}
              isSelf={isSelf}
              busy={busy}
              onOpenDm={() => void openDm()}
              onCopyId={() => void copyUserId()}
              onBlock={() => void handleBlock()}
              onUnblock={() => void handleUnblock()}
              onEditProfile={() => {
                close()
                openSettings('account')
              }}
            />
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <UserGlobalProfileSections
              mutualServers={mutualServers}
              busy={busy}
              onServerSelect={handleServerSelect}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
