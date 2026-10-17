import { useTranslations } from '@syrnike13/ui/i18n'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { SettingsIcon, XIcon } from '#/components/icons'

import { SettingsProfileStatusDialog } from '#/components/settings/settings-profile-status-dialog'
import { CurrentUserProfileMenu } from '#/components/user/current-user-profile-menu'
import { MobilePresenceDrawer } from '#/components/user/mobile-presence-drawer'
import {
  Button,
  buttonVariants,
} from '@syrnike13/ui/primitives/button'
import { cn } from '#/lib/utils'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
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
  const t = useTranslations('layout.user')
  const auth = useAuth()
  const user = auth.user
  const token = auth.session?.token
  const [presenceDrawerOpen, setPresenceDrawerOpen] = useState(false)
  const [statusDialogOpen, setStatusDialogOpen] = useState(false)
  const { setCustomStatus } = useSetCustomStatus()
  const { openSettings } = useSettingsModal()

  const profileQuery = useQuery({
    queryKey: queryKeys.users.profile(user?._id ?? ''),
    queryFn: ({ signal }) => fetchUserProfile(token!, user!._id, signal),
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
              <Link
                to="/m"
                search={{ tab: 'online' }}
                className={cn(
                  buttonVariants({ variant: 'scrim', size: 'icon' }),
                  'size-10 rounded-full',
                )}
                aria-label={t('close')}
                title={t('close')}
              >
                <XIcon className="size-5" />
              </Link>
              <Button
                type="button"
                variant="scrim"
                size="icon"
                className="size-10 rounded-full"
                aria-label={t('settings')}
                title={t('settings')}
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
