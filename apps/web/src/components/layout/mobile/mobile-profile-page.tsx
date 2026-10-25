import { useTranslations } from '@syrnike13/ui/i18n'
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { SettingsIcon, XIcon } from '#/components/icons'

import { CurrentUserStatusDialog } from '#/components/user/current-user-status-dialog'
import { CurrentUserProfileMenu } from '#/components/user/current-user-profile-menu'
import { MobilePresenceDrawer } from '#/components/user/mobile-presence-drawer'
import {
  Button,
  buttonVariants,
} from '@syrnike13/ui/primitives/button'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { useSettingsModal } from '#/features/settings/settings-modal-context'

/**
 * Полноэкранная страница профиля текущего пользователя (мобильная).
 */
export function MobileProfilePage() {
  const t = useTranslations('layout.user')
  const auth = useAuth()
  const user = auth.user
  const [presenceDrawerOpen, setPresenceDrawerOpen] = useState(false)
  const [statusDialogOpen, setStatusDialogOpen] = useState(false)
  const { openSettings } = useSettingsModal()

  if (!user) return null

  const customStatus = user.status?.text?.trim() ?? ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
                className={buttonVariants({
                  variant: 'overlay',
                  size: 'icon-lg',
                  shape: 'circle',
                })}
                aria-label={t('close')}
                title={t('close')}
              >
                <XIcon />
              </Link>
              <Button
                type="button"
                variant="overlay"
                size="icon-lg"
                shape="circle"
                aria-label={t('settings')}
                title={t('settings')}
                onClick={() => openSettings()}
              >
                <SettingsIcon />
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

      <CurrentUserStatusDialog
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
      />
    </div>
  )
}
