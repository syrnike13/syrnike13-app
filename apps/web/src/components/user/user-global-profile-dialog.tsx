import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { BlockUserConfirmationDialog } from '#/components/user/block-user-confirmation-dialog'
import { UserGlobalProfileSections } from '#/components/user/user-global-profile-sections'
import { UserGlobalProfileSidebar } from '#/components/user/user-global-profile-sidebar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '#/components/ui/dialog'
import { useAuth } from '#/features/auth/auth-context'
import { openDirectMessageChannel } from '#/features/dm/dm-actions'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { blockUserRelationship } from '#/features/friends/friend-actions'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { listMutualServers, listServerChannels } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { writeClipboardText } from '#/lib/clipboard'

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
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const { openSettings } = useSettingsModal()
  const [busy, setBusy] = useState(false)
  const [blockDialogOpen, setBlockDialogOpen] = useState(false)

  const isSelf = user._id === auth.user?._id
  const canDirectMessage = !isSelf && !user.bot
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
      await openDirectMessageChannel(token, user._id, (channelId) => {
        close()
        return navigate({
          to: `${prefix}/c/$channelId`,
          params: { channelId },
          search: { m: undefined },
        })
      })
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
      await blockUserRelationship(token, user._id)
      setBlockDialogOpen(false)
      close()
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  async function copyUserId() {
    try {
      await writeClipboardText(user._id)
      toast.success('ID скопирован')
    } catch {
      toast.error('Не удалось скопировать')
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
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex h-[min(660px,90vh)] max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[900px]"
          showCloseButton
        >
          <DialogTitle className="sr-only">Профиль {displayName}</DialogTitle>
          <DialogDescription className="sr-only">
            Глобальный профиль пользователя {displayName}
          </DialogDescription>

          <div className="flex min-h-0 flex-1 overflow-hidden p-6">
            <aside className="flex w-1/2 min-w-0 shrink-0 flex-col overflow-hidden bg-background ">
              <UserGlobalProfileSidebar
                user={user}
                serverId={serverId}
                isSelf={isSelf}
                busy={busy}
                onOpenDm={() => void openDm()}
                onCopyId={() => void copyUserId()}
                onBlock={() => setBlockDialogOpen(true)}
                onEditProfile={() => {
                  close()
                  openSettings('account')
                }}
              />
            </aside>

            <div className="flex min-w-0 flex-1 flex-col bg-background">
              <UserGlobalProfileSections
                mutualServers={mutualServers}
                busy={busy}
                onServerSelect={handleServerSelect}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <BlockUserConfirmationDialog
        open={blockDialogOpen}
        username={user.username}
        disabled={busy}
        onOpenChange={(open) => {
          if (!busy) setBlockDialogOpen(open)
        }}
        onConfirm={() => void handleBlock()}
      />
    </>
  )
}
