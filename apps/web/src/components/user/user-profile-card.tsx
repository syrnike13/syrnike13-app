import { useNavigate } from '@tanstack/react-router'
import {
  HeadphonesIcon,
  Loader2Icon,
  MessageCircleIcon,
} from '#/components/icons'
import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { FriendshipAction } from '#/components/friends/friendship-action'
import { UserProfileCardHeader } from '#/components/user/user-profile-card-header'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { useAuth } from '#/features/auth/auth-context'
import { openDirectMessageChannel } from '#/features/dm/dm-actions'
import {
  selectDirectMessageCallActionLabel,
  type MemberRoleEntry,
} from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { useVoice } from '#/features/voice/voice-context'

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
  const voice = useVoice()

  const [busy, setBusy] = useState(false)
  const [messageDraft, setMessageDraft] = useState('')

  const isSelf = profile._id === auth.user?._id
  const canMessage = !hideMessage && !isSelf && !profile.bot
  const directCallActionLabel = useSyncStore((s) =>
    selectDirectMessageCallActionLabel(s, auth.user?._id, profile._id),
  )

  function dismiss() {
    onClose?.()
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
          to: '/app/c/$channelId',
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

  async function startDirectCall() {
    const token = auth.session?.token
    if (!token || !canMessage) return
    setBusy(true)
    try {
      const channel = await openDirectMessageChannel(
        token,
        profile._id,
        (channelId) => {
          dismiss()
          setMessageDraft('')
          return navigate({
            to: '/app/c/$channelId',
            params: { channelId },
            search: { m: undefined },
          })
        },
      )
      await voice.join(channel._id)
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
      />

      {!isSelf ? (
        <FriendshipAction user={profile} className="px-4 pt-1 pb-2" />
      ) : null}

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
              className="h-10 rounded-lg border-border bg-secondary pr-20 text-sm text-secondary-foreground shadow-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-accent dark:text-accent-foreground"
              onChange={(event) => setMessageDraft(event.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={busy}
              className="absolute top-1/2 right-10 size-8 -translate-y-1/2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title={directCallActionLabel}
              aria-label={directCallActionLabel}
              onClick={() => void startDirectCall()}
            >
              {busy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <HeadphonesIcon className="size-4" />
              )}
            </Button>
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              disabled={busy}
              className="absolute top-1/2 right-1.5 size-8 -translate-y-1/2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title="Открыть ЛС"
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
