import type {
  FeedbackModerationStatus,
  FeedbackProductStatus,
} from '@syrnike13/api-types'

import {
  FEEDBACK_MODERATION_LABELS,
  feedbackModerationClass,
  feedbackProductStatusLabel,
  feedbackStatusClass,
} from '#/components/feedback/feedback-meta'
import { cn } from '#/lib/utils'

const statusBaseClass =
  'inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold'

export function FeedbackProductStatus({
  status,
}: {
  status: FeedbackProductStatus
}) {
  return (
    <span className={cn(statusBaseClass, feedbackStatusClass(status))}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {feedbackProductStatusLabel(status)}
    </span>
  )
}

export function FeedbackModerationStatus({
  status,
}: {
  status: FeedbackModerationStatus
}) {
  return (
    <span className={cn(statusBaseClass, feedbackModerationClass(status))}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {FEEDBACK_MODERATION_LABELS[status]}
    </span>
  )
}
