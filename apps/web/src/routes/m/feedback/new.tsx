import { createFileRoute } from '@tanstack/react-router'

import { FeedbackCreateForm } from '#/components/feedback/feedback-create-form'

export const Route = createFileRoute('/m/feedback/new')({
  component: FeedbackCreateForm,
})
