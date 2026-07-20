import type {
  FeedbackCategory,
  FeedbackModerationStatus,
  FeedbackProductStatus,
} from '@syrnike13/api-types'

import {
  FEEDBACK_MODERATION_LABELS,
  feedbackCategoryClass,
  feedbackCategoryLabel,
  feedbackModerationClass,
  feedbackProductStatusLabel,
  feedbackStatusClass,
} from '#/components/feedback/feedback-meta'
import { cn } from '#/lib/utils'

const statusBaseClass =
  'inline-flex min-h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold'

export function FeedbackProductStatus({
  status,
}: {
  status: FeedbackProductStatus
}) {
  const label = feedbackProductStatusLabel(status)
  if (!label) return null

  return (
    <span className={cn(statusBaseClass, feedbackStatusClass(status))}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  )
}

export function FeedbackCategoryBadge({ category }: { category: FeedbackCategory }) {
  return (
    <span className={cn(statusBaseClass, feedbackCategoryClass(category))}>
      {feedbackCategoryLabel(category)}
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
