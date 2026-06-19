import { createFileRoute } from '@tanstack/react-router'

import { AdminBadgesPage } from './-badges-page'

export const Route = createFileRoute('/admin/badges')({
  component: AdminBadgesPage,
})
