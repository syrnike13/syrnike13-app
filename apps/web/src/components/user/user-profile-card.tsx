import { useNavigate } from '@tanstack/react-router'
import {
  BanIcon,
  Loader2Icon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  UserMinusIcon,
} from '#/components/icons'
import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { UserProfileCardHeader } from '#/components/user/user-profile-card-header'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { FloatingMenuItem } from '#/components/ui/floating-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { useAuth } from '#/features/auth/auth-context'
import {
  banServerMember,
  kickServerMember,
} from '#/features/api/servers-api'
import { blockUser, openDirectMessage } from '#/features/api/users-api'
import type { MemberRoleEntry } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  canBanServerMember,
  canKickServerMember,
} from '#/lib/permissions'
export type UserProfileCardProps = {
  user: User
  hideMessage?: boolean
  serverId?: string
  serverName?: string
  roles?: MemberRoleEntry[]
  onClose?: () => void
}

export function UserProfileCard({
  user: profile,
  hideMessage,
  serverId,
  serverName: serverNameProp,
  roles: rolesProp,
  onClose,
}: UserProfileCardProps) {
  const auth = useAuth()
  const navigate = useNavigate()

  const [busy, setBusy] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [messageDraft, setMessageDraft] = useState('')

  const isSelf = profile._id === auth.user?._id
  const canMessage = !hideMessage && !isSelf
  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const actorMember = useSyncStore((s) =>
    serverId && auth.user?._id
      ? s.members[`${serverId}:${auth.user._id}`]
      : undefined,
  )
  const targetMember = useSyncStore((s) =>
    serverId ? s.members[`${serverId}:${profile._id}`] : undefined,
  )
  const canKick =
    server &&
    canKickServerMember(server, actorMember, auth.user?._id, targetMember)
  const canBan =
    server &&
    canBanServerMember(server, actorMember, auth.user?._id, targetMember)
  const showProfileActions = canKick || canBan || !isSelf

  function dismiss() {
    onClose?.()
  }

  async function openDm(prefill?: string) {
    const token = auth.session?.token
    if (!token) return
    setBusy(true)
    try {
      const channel = await openDirectMessage(token, profile._id)
      syncStore.upsertChannel(channel)
      dismiss()
      setMessageDraft('')
      await navigate({
        to: '/app/c/$channelId',
        params: { channelId: channel._id },
        search: { m: undefined },
      })
      if (prefill?.trim()) {
        toast.message('Откройте чат и отправьте сообщение', {
          description: prefill.trim(),
        })
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось открыть ЛС',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleKick() {
    const token = auth.session?.token
    if (!token || !serverId || isSelf) return
    if (!window.confirm(`Исключить @${profile.username} с сервера?`)) return
    setBusy(true)
    try {
      await kickServerMember(token, serverId, profile._id)
      syncStore.removeServerMember(serverId, profile._id)
      dismiss()
      toast.success('Участник исключён')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось исключить',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleBan() {
    const token = auth.session?.token
    if (!token || !serverId || isSelf) return
    if (
      !window.confirm(
        `Забанить @${profile.username}? Пользователь не сможет вернуться на сервер.`,
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await banServerMember(token, serverId, profile._id)
      syncStore.removeServerMember(serverId, profile._id)
      dismiss()
      toast.success('Пользователь забанен')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось забанить',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleBlock() {
    const token = auth.session?.token
    if (!token || isSelf) return
    if (!window.confirm(`Заблокировать @${profile.username}?`)) return
    setBusy(true)
    try {
      const updated = await blockUser(token, profile._id)
      syncStore.upsertUser(updated)
      dismiss()
      toast.success('Пользователь заблокирован')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось заблокировать',
      )
    } finally {
      setBusy(false)
    }
  }

  const bannerActions =
    showProfileActions ? (
      <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-full bg-foreground/20 text-primary-foreground hover:bg-foreground/30 hover:text-primary-foreground"
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="left"
          align="start"
          sideOffset={8}
          className="z-[250] w-auto min-w-[11rem] p-1"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          {canKick ? (
            <FloatingMenuItem
              onClick={() => {
                setActionsOpen(false)
                void handleKick()
              }}
            >
              <UserMinusIcon className="size-3.5" />
              Исключить
            </FloatingMenuItem>
          ) : null}
          {canBan ? (
            <FloatingMenuItem
              onClick={() => {
                setActionsOpen(false)
                void handleBan()
              }}
            >
              <BanIcon className="size-3.5" />
              Бан на сервере
            </FloatingMenuItem>
          ) : null}
          {!isSelf ? (
            <FloatingMenuItem
              onClick={() => {
                setActionsOpen(false)
                void handleBlock()
              }}
            >
              <BanIcon className="size-3.5" />
              Заблокировать
            </FloatingMenuItem>
          ) : null}
        </PopoverContent>
      </Popover>
    ) : null

  return (
    <>
      <UserProfileCardHeader
        user={profile}
        serverId={serverId}
        serverName={serverNameProp}
        roles={rolesProp}
        bannerActions={bannerActions}
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
