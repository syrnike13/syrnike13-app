import { createFileRoute } from '@tanstack/react-router'

import { FeedbackModerationPage } from '#/features/feedback/feedback-moderation'

export const Route = createFileRoute('/_admin/feedback/')({
  component: FeedbackModerationPage,
})
