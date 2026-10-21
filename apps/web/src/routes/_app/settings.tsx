import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'

import { useSettingsModal } from '#/features/settings/settings-modal-context'

export const Route = createFileRoute('/_app/settings')({
  component: SettingsRoute,
})

function SettingsRoute() {
  const navigate = useNavigate()
  const { openSettings } = useSettingsModal()

  useEffect(() => {
    openSettings('account')
    void navigate({
      to: '/',
      search: { tab: 'online' },
      replace: true,
    })
  }, [navigate, openSettings])

  return null
}
