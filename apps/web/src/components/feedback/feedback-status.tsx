import type {
  FeedbackCategory,
  FeedbackModerationStatus,
  FeedbackProductStatus,
} from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  FEEDBACK_MODERATION_KEYS,
  feedbackCategoryClass,
  feedbackCategoryLabel,
  feedbackModerationClass,
  feedbackProductStatusLabel,
  feedbackStatusClass,
} from '#/components/feedback/feedback-meta'
import { cn } from '#/lib/utils'

const statusBaseClass =
  'inline-flex min-h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-semibold'

export function FeedbackProductStatus({
  status,
}: {
  status: FeedbackProductStatus
}) {
  const t = useTranslations('feedback.meta')
  const label = feedbackProductStatusLabel(status, t)
  if (!label) return null

  return (
    <span className={cn(statusBaseClass, feedbackStatusClass(status))}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  )
}

export function FeedbackCategoryBadge({ category }: { category: FeedbackCategory }) {
  const t = useTranslations('feedback.meta')
  return (
    <span className={cn(statusBaseClass, feedbackCategoryClass(category))}>
      {feedbackCategoryLabel(category, t)}
    </span>
  )
}

export function FeedbackModerationStatus({
  status,
}: {
  status: FeedbackModerationStatus
}) {
  const t = useTranslations('feedback.meta')
  return (
    <span className={cn(statusBaseClass, feedbackModerationClass(status))}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {t(FEEDBACK_MODERATION_KEYS[status])}
    </span>
  )
}
