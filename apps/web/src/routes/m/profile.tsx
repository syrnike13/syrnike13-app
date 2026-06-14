import { createFileRoute } from '@tanstack/react-router'

import { MobileProfilePage } from '#/components/layout/mobile/mobile-profile-page'

export const Route = createFileRoute('/m/profile')({
  component: MobileProfileRoute,
})

function MobileProfileRoute() {
  return <MobileProfilePage />
}
