import { createFileRoute } from '@tanstack/react-router'

import { ActivityEditorPage } from '#/features/activities/activity-editor'

export const Route = createFileRoute('/_admin/activities/new')({
  component: NewActivityPage,
})

function NewActivityPage() {
  return <ActivityEditorPage mode="create" />
}
