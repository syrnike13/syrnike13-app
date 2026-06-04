import { useNavigate } from '@tanstack/react-router'
import {
  BanIcon,
  Loader2Icon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  UserMinusIcon,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { UserAvatar } from '#/components/user/user-avatar'
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
import {
  blockUser,
  fetchUserProfile,
  openDirectMessage,
} from '#/features/api/users-api'
import { queryKeys } from '#/lib/api/query-keys'
import { userBannerUrl } from '#/lib/media'
import { cn } from '#/lib/utils'
import {
  memberRoleEntries,
  type MemberRoleEntry,
} from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
export type UserProfileCardProps = {
  user: User
  hideMessage?: boolean
  serverId?: string
  serverName?: string
  roles?: MemberRoleEntry[]
  onClose?: () => void
}

function roleDotStyle(colour: string | null) {
  if (!colour) return { backgroundColor: 'var(--muted-foreground)' }
  return { backgroundColor: colour.startsWith('#') ? colour : `#${colour}` }
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
  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const member = useSyncStore((s) =>
    serverId ? s.members[`${serverId}:${profile._id}`] : undefined,
  )
  const roles =
    rolesProp ?? (member ? memberRoleEntries(server, member) : [])
  const serverName = serverNameProp ?? server?.name

  const [busy, setBusy] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [messageDraft, setMessageDraft] = useState('')

  const isSelf = profile._id === auth.user?._id
  const canMessage = !hideMessage && !isSelf
  const canModerate = Boolean(serverId) && !isSelf
  const displayName = profile.display_name ?? profile.username
  const token = auth.session?.token

  const profileQuery = useQuery({
    queryKey: queryKeys.users.profile(profile._id),
    queryFn: () => fetchUserProfile(token!, profile._id),
    enabled: Boolean(token),
    staleTime: 60_000,
  })

  const bannerUrl = userBannerUrl(profileQuery.data?.background)
  const profileBio = profileQuery.data?.content?.trim()

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

  return (
    <>
      <div className="relative">
        <div
          className={cn(
            'relative w-full overflow-hidden',
            bannerUrl ? 'h-[120px]' : 'h-[88px]',
            !bannerUrl &&
              'bg-gradient-to-br from-primary via-chart-4 to-sidebar-primary',
          )}
        >
          {bannerUrl ? (
            <>
              <img
                src={bannerUrl}
                alt=""
                className="size-full object-cover"
              />
              <div
                className="absolute inset-0 bg-background/30"
                aria-hidden
              />
            </>
          ) : null}
        </div>
        {(canModerate || !isSelf) && (
          <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-2 right-2 size-8 rounded-full bg-foreground/20 text-primary-foreground hover:bg-foreground/30 hover:text-primary-foreground"
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
              {canModerate ? (
                <>
                  <FloatingMenuItem
                    onClick={() => {
                      setActionsOpen(false)
                      void handleKick()
                    }}
                  >
                    <UserMinusIcon className="size-3.5" />
                    Исключить
                  </FloatingMenuItem>
                  <FloatingMenuItem
                    onClick={() => {
                      setActionsOpen(false)
                      void handleBan()
                    }}
                  >
                    <BanIcon className="size-3.5" />
                    Бан на сервере
                  </FloatingMenuItem>
                </>
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
        )}
        <div className="absolute -bottom-8 left-4">
          <UserAvatar
            user={profile}
            className="size-20"
            fallbackClassName="size-20 text-xl ring-[6px] ring-muted"
            showPresence
            presenceRingClassName="border-muted"
            presenceClassName="size-7 translate-x-[16%] translate-y-[16%] border-4"
          />
        </div>
      </div>

      <div className="px-4 pt-10 pb-3">
        <h2 className="truncate text-xl font-bold leading-tight text-foreground">
          {displayName}
        </h2>
        <p className="truncate text-sm text-muted-foreground">
          {profile.display_name ? `@${profile.username}` : profile.username}
        </p>
        {profileBio ? (
          <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
            {profileBio}
          </p>
        ) : null}
        {serverName ? (
          <p className="mt-1 text-xs text-muted-foreground/80">
            Участник · {serverName}
          </p>
        ) : null}
      </div>

      {roles.length > 0 ? (
        <div className="px-4 py-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Роли
          </p>
          <div className="flex flex-wrap gap-1.5">
            {roles.map((role) => (
              <span
                key={role.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={roleDotStyle(role.colour)}
                />
                <span className="truncate">{role.name}</span>
              </span>
            ))}
          </div>
        </div>
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
