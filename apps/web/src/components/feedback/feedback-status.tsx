import type {
  FeedbackCategory,
  FeedbackModerationStatus,
  FeedbackProductStatus,
} from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  FEEDBACK_MODERATION_KEYS,
  feedbackCategoryLabel,
  feedbackCategoryVariant,
  feedbackModerationVariant,
  feedbackProductStatusLabel,
  feedbackStatusVariant,
} from '#/components/feedback/feedback-meta'
import { Badge } from '@syrnike13/ui/primitives/badge'

export function FeedbackProductStatus({ status }: { status: FeedbackProductStatus }) {
  const t = useTranslations('feedback.meta')
  const label = feedbackProductStatusLabel(status, t)
  if (!label) return null
  return <Badge variant={feedbackStatusVariant(status)}>{label}</Badge>
}

export function FeedbackCategoryBadge({ category }: { category: FeedbackCategory }) {
  const t = useTranslations('feedback.meta')
  return <Badge variant={feedbackCategoryVariant(category)}>{feedbackCategoryLabel(category, t)}</Badge>
}

export function FeedbackModerationStatus({ status }: { status: FeedbackModerationStatus }) {
  const t = useTranslations('feedback.meta')
  return <Badge variant={feedbackModerationVariant(status)}>{t(FEEDBACK_MODERATION_KEYS[status])}</Badge>
}
