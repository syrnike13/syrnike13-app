import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'

import { useSettingsModal } from '#/features/settings/settings-modal-context'

/**
 * `/m/settings` — на мобиле открывает полноэкранные настройки (модалку)
 * и сразу уходит на home. На этапе 4.6 можно заменить на отдельную страницу.
 */
export const Route = createFileRoute('/m/settings')({
  component: MobileSettingsRoute,
})

function MobileSettingsRoute() {
  const navigate = useNavigate()
  const { openSettings } = useSettingsModal()

  useEffect(() => {
    openSettings('account')
    void navigate({
      to: '/m',
      search: { tab: 'online' },
      replace: true,
    })
  }, [navigate, openSettings])

  return null
}
