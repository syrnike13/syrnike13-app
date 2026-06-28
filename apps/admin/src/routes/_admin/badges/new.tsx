import { createFileRoute } from '@tanstack/react-router'

import { BadgeEditorPage } from '#/features/badges/badge-editor'

export const Route = createFileRoute('/_admin/badges/new')({
  component: NewBadgePage,
})

function NewBadgePage() {
  return <BadgeEditorPage mode="create" />
}
