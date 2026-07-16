import { createFileRoute } from '@tanstack/react-router'

import { BadgesCatalogPage } from '#/features/badges/badges-catalog'

export const Route = createFileRoute('/_admin/badges/')({
  component: BadgesCatalogPage,
})
