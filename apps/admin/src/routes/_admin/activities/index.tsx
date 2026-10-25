import { createFileRoute } from '@tanstack/react-router'

import { ActivitiesCatalogPage } from '#/features/activities/activities-catalog'

export const Route = createFileRoute('/_admin/activities/')({
  component: ActivitiesCatalogPage,
})
