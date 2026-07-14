import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { SettingsIcon, XIcon } from '#/components/icons'

import { SettingsProfileStatusDialog } from '#/components/settings/settings-profile-status-dialog'
import { CurrentUserProfileMenu } from '#/components/user/current-user-profile-menu'
import { MobilePresenceDrawer } from '#/components/user/mobile-presence-drawer'
import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { fetchUserProfile } from '#/features/api/users-api'
import { useSetCustomStatus } from '#/features/users/use-set-custom-status'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { queryKeys } from '#/lib/api/query-keys'
import { userAvatarUrl, userBannerUrl } from '#/lib/media'

/**
 * Полноэкранная страница профиля текущего пользователя (мобильная).
 */
export function MobileProfilePage() {
  const auth = useAuth()
  const user = auth.user
  const token = auth.session?.token
  const [presenceDrawerOpen, setPresenceDrawerOpen] = useState(false)
  const [statusDialogOpen, setStatusDialogOpen] = useState(false)
  const { setCustomStatus } = useSetCustomStatus()
  const { openSettings } = useSettingsModal()

  const profileQuery = useQuery({
    queryKey: queryKeys.users.profile(user?._id ?? ''),
    queryFn: () => fetchUserProfile(token!, user!._id),
    enabled: Boolean(token && user),
    staleTime: 60_000,
  })

  if (!user) return null

  const displayName = user.display_name ?? user.username
  const customStatus = user.status?.text?.trim() ?? ''
  const avatarUrl = userAvatarUrl(user.avatar, { animated: true })
  const bannerUrl = userBannerUrl(profileQuery.data?.background, {
    animated: true,
  })

  return (
    <div className="gradient-surface-content flex min-h-0 flex-1 flex-col bg-background">
      <ScrollArea className="min-h-0 flex-1">
        <CurrentUserProfileMenu
          user={user}
          hidePresenceRow
          onAvatarPress={() => setPresenceDrawerOpen(true)}
          bannerOverlay={
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-10 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
                aria-label="Закрыть"
                title="Закрыть"
                asChild
              >
                <Link to="/m" search={{ tab: 'online' }}>
                  <XIcon className="size-5" />
                </Link>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-10 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
                aria-label="Настройки"
                title="Настройки"
                onClick={() => openSettings()}
              >
                <SettingsIcon className="size-5" />
              </Button>
            </>
          }
        />

      </ScrollArea>

      <MobilePresenceDrawer
        open={presenceDrawerOpen}
        onOpenChange={setPresenceDrawerOpen}
        customStatus={customStatus}
        onEditCustomStatus={() => setStatusDialogOpen(true)}
      />

      <SettingsProfileStatusDialog
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
        statusText={customStatus}
        onApply={(text) => void setCustomStatus(text)}
        user={user}
        displayName={displayName}
        username={user.username}
        avatarUrl={avatarUrl}
        bannerUrl={bannerUrl}
      />
    </div>
  )
}
