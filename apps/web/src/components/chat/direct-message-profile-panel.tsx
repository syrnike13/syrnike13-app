import { useQuery } from '@tanstack/react-query'
import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { User } from '@syrnike13/api-types'

import { FxImage } from '#/components/ui/fx-image'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserProfileStatusBubble } from '#/components/user/user-profile-status-bubble'
import { fetchUserProfile } from '#/features/api/users-api'
import { listMutualServers } from '#/features/sync/selectors'
import { useMutualServerMembersSync } from '#/features/sync/mutual-server-members-sync'
import { useSyncStore } from '#/features/sync/sync-store'
import { queryKeys } from '#/lib/api/query-keys'
import { userBannerUrl } from '#/lib/media'
import { userProfileBannerClassName } from '#/lib/user-profile-banner'
import { cn } from '#/lib/utils'

const DEFAULT_PROFILE_PANEL_WIDTH = 320
const MIN_PROFILE_PANEL_WIDTH = 280
const MAX_PROFILE_PANEL_WIDTH = 440

function clampPanelWidth(width: number) {
  return Math.min(
    MAX_PROFILE_PANEL_WIDTH,
    Math.max(MIN_PROFILE_PANEL_WIDTH, width),
  )
}

type DirectMessageProfilePanelProps = {
  user: User
  currentUserId?: string
  token?: string | null
  aliases: string[]
  open: boolean
  onWidthChange?: (width: number) => void
  onResizingChange?: (resizing: boolean) => void
  onOpenProfile?: () => void
}

export function DirectMessageProfilePanel({
  user,
  currentUserId,
  token,
  aliases,
  open,
  onWidthChange,
  onResizingChange,
  onOpenProfile,
}: DirectMessageProfilePanelProps) {
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PROFILE_PANEL_WIDTH)
  useMutualServerMembersSync(user._id, currentUserId, token)
  const mutualServers = useSyncStore((s) =>
    listMutualServers(s, user._id, currentUserId),
  )
  const profileQuery = useQuery({
    queryKey: queryKeys.users.profile(user._id),
    queryFn: () => fetchUserProfile(token!, user._id),
    enabled: Boolean(token),
    staleTime: 60_000,
  })

  const displayName = user.display_name ?? user.username
  const customStatus = user.status?.text?.trim()
  const profileBio = profileQuery.data?.content?.trim()
  const bannerUrl = userBannerUrl(profileQuery.data?.background, {
    animated: true,
  })
  const mutualServerNames = mutualServers.map((server) => server.name)

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    onResizingChange?.(true)

    const startX = event.clientX
    const startWidth = panelWidth

    function handlePointerMove(moveEvent: PointerEvent) {
      const nextWidth = clampPanelWidth(startWidth + startX - moveEvent.clientX)
      setPanelWidth(nextWidth)
      onWidthChange?.(nextWidth)
    }

    function stopResize() {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onResizingChange?.(false)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize, { once: true })
  }

  return (
    <aside
      aria-label="Профиль пользователя"
      aria-hidden={!open}
      data-state={open ? 'open' : 'closed'}
      inert={!open}
      className={cn(
        'relative z-20 min-h-0 w-0 shrink-0 overflow-visible',
        !open && 'pointer-events-none',
      )}
    >
      <div
        data-dm-profile-surface
        className={cn(
          'absolute inset-y-0 right-0 z-10 flex min-h-0 flex-col overflow-y-auto border-l border-shell-divider bg-card shadow-sm will-change-[translate,opacity] transition-[translate,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          open ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0',
        )}
        style={{
          width: panelWidth,
          minWidth: MIN_PROFILE_PANEL_WIDTH,
          maxWidth: '42vw',
        }}
      >
        <div
          aria-label="Изменить ширину профиля"
          aria-orientation="vertical"
          className="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize touch-none transition-colors hover:bg-primary/50"
          role="separator"
          onPointerDown={startResize}
        />

        <div className="relative shrink-0">
          <div
            className={userProfileBannerClassName(
              'bg-secondary',
              !bannerUrl &&
                'bg-gradient-to-br from-secondary via-muted to-sidebar-accent',
            )}
          >
            {bannerUrl ? (
              <>
                <FxImage
                  src={bannerUrl}
                  wrapperClassName="block h-full w-full"
                  className="h-full w-full object-cover"
                />
                <div
                  className="pointer-events-none absolute inset-0 bg-background/25"
                  aria-hidden
                />
              </>
            ) : null}
          </div>
          <div className="absolute -bottom-11 left-4 z-10">
            <UserProfileStatusBubble
              status={customStatus}
              className="left-full top-[45%] ml-2"
            />
            {onOpenProfile ? (
              <button
                type="button"
                title="Открыть профиль"
                className="group/avatar-button cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
                onClick={onOpenProfile}
              >
                <span className="relative block rounded-full">
                  <UserAvatar
                    user={user}
                    className="size-[88px]"
                    fallbackClassName="size-[88px] text-2xl ring-[5px] ring-card bg-muted"
                    animated="always"
                    showPresence
                    presenceRingClassName="border-card"
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-full bg-black/0 transition-colors group-hover/avatar-button:bg-black/25"
                  />
                </span>
              </button>
            ) : (
              <UserAvatar
                user={user}
                className="size-[88px]"
                fallbackClassName="size-[88px] text-2xl ring-[5px] ring-card bg-muted"
                animated="always"
                showPresence
                presenceRingClassName="border-card"
              />
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-4 pt-14 pb-4">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold leading-tight text-foreground">
              {displayName}
            </h2>
            <p className="truncate text-sm text-muted-foreground">
              {user.display_name ? `@${user.username}` : user.username}
            </p>
          </div>

          <div className="mt-4 space-y-2">
            {profileBio ? (
              <div className="rounded-md bg-secondary/70 p-3">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  О себе
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                  {profileBio}
                </p>
              </div>
            ) : null}

            {aliases.length > 0 ? (
              <div className="rounded-md bg-secondary/70 p-3">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  AKA
                </p>
                <p className="truncate text-sm font-medium text-foreground">
                  {aliases.join(', ')}
                </p>
              </div>
            ) : null}

            <div className="rounded-md bg-secondary/70 p-3">
              <p className="text-sm font-semibold text-foreground">
                Общие серверы — {mutualServers.length}
              </p>
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {mutualServerNames.length > 0
                  ? mutualServerNames.join(', ')
                  : 'Нет общих серверов'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}
