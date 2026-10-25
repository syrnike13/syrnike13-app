import type {
  FeedbackArea,
  FeedbackCategory,
  FeedbackModerationStatus,
  FeedbackPlatform,
  FeedbackProductStatus,
} from '@syrnike13/api-types'
import type { Translator } from '@syrnike13/ui/i18n'

export const FEEDBACK_CATEGORIES = [
  {
    value: 'bug',
    labelKey: 'categories.bug.label',
    descriptionKey: 'categories.bug.description',
  },
  {
    value: 'idea',
    labelKey: 'categories.idea.label',
    descriptionKey: 'categories.idea.description',
  },
] satisfies {
  value: FeedbackCategory
  labelKey: string
  descriptionKey: string
}[]

export const FEEDBACK_AREAS = [
  { value: 'navigation', labelKey: 'areas.navigation' },
  { value: 'voice_video', labelKey: 'areas.voice_video' },
  { value: 'community', labelKey: 'areas.community' },
  { value: 'messages', labelKey: 'areas.messages' },
  { value: 'moderation', labelKey: 'areas.moderation' },
  { value: 'desktop', labelKey: 'areas.desktop' },
  { value: 'activities', labelKey: 'areas.activities' },
  { value: 'other', labelKey: 'areas.other' },
] satisfies { value: FeedbackArea; labelKey: string }[]

const FEEDBACK_AREA_KEYS: Record<FeedbackArea, string> = {
  navigation: 'areas.navigation',
  voice_video: 'areas.voice_video',
  community: 'areas.community',
  messages: 'areas.messages',
  moderation: 'areas.moderation',
  desktop: 'areas.desktop',
  activities: 'areas.activities',
  other: 'areas.other',
}

export const FEEDBACK_PLATFORMS = [
  { value: 'windows', labelKey: 'platforms.windows' },
  { value: 'macos', labelKey: 'platforms.macos' },
  { value: 'linux', labelKey: 'platforms.linux' },
  { value: 'web', labelKey: 'platforms.web' },
  { value: 'android', labelKey: 'platforms.android' },
  { value: 'ios', labelKey: 'platforms.ios' },
] satisfies { value: FeedbackPlatform; labelKey: string }[]

export const FEEDBACK_PRODUCT_STATUSES: {
  value: FeedbackProductStatus
  labelKey: string
}[] = [
  { value: 'under_consideration', labelKey: 'statuses.under_consideration' },
  { value: 'planned', labelKey: 'statuses.planned' },
  { value: 'in_progress', labelKey: 'statuses.in_progress' },
  { value: 'released', labelKey: 'statuses.released' },
  { value: 'not_planned', labelKey: 'statuses.not_planned' },
]

export const FEEDBACK_MODERATION_KEYS: Record<
  FeedbackModerationStatus,
  string
> = {
  pending: 'moderation.pending',
  approved: 'moderation.approved',
  rejected: 'moderation.rejected',
  merged: 'moderation.merged',
  hidden: 'moderation.hidden',
}

export function feedbackCategoryLabel(
  category: FeedbackCategory,
  t: Translator,
) {
  const item = FEEDBACK_CATEGORIES.find((entry) => entry.value === category)
  return item ? t(item.labelKey) : category
}

export function feedbackAreaLabel(area: FeedbackArea, t: Translator) {
  return t(FEEDBACK_AREA_KEYS[area] ?? 'areas.other')
}

export function feedbackPlatformLabel(
  platform: FeedbackPlatform,
  t: Translator,
) {
  const item = FEEDBACK_PLATFORMS.find((entry) => entry.value === platform)
  return item ? t(item.labelKey) : platform
}

export function feedbackProductStatusLabel(
  status: FeedbackProductStatus,
  t: Translator,
) {
  if (status === 'collecting') return null
  const item = FEEDBACK_PRODUCT_STATUSES.find((entry) => entry.value === status)
  return item ? t(item.labelKey) : status
}

/** `Badge` variants: the status meaning maps onto the primitive's tints. */
export type FeedbackBadgeVariant = 'destructive' | 'info' | 'success' | 'warning' | 'secondary'

export function feedbackCategoryVariant(category: FeedbackCategory): FeedbackBadgeVariant {
  return category === 'bug' ? 'destructive' : 'info'
}

export function feedbackStatusVariant(status: FeedbackProductStatus): FeedbackBadgeVariant {
  switch (status) {
    case 'in_progress':
    case 'released':
      return 'success'
    case 'planned':
      return 'warning'
    case 'not_planned':
      return 'destructive'
    case 'collecting':
    case 'under_consideration':
      return 'info'
  }
}

export function feedbackModerationVariant(status: FeedbackModerationStatus): FeedbackBadgeVariant {
  switch (status) {
    case 'approved':
      return 'success'
    case 'pending':
      return 'info'
    case 'rejected':
      return 'destructive'
    case 'merged':
    case 'hidden':
      return 'secondary'
  }
}
