import { createFileRoute, notFound } from '@tanstack/react-router'

import { UiGalleryPage } from '#/features/ui-gallery/ui-gallery-page'

export const Route = createFileRoute('/dev/ui')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound()
  },
  component: UiGalleryPage,
})
