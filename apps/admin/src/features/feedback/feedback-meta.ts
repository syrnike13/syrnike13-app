import type {
  FeedbackArea,
  FeedbackCategory,
  FeedbackPlatform,
  FeedbackProductStatus,
} from '@syrnike13/api-types'
import type { Translator } from '@syrnike13/ui/i18n'

export type PublicFeedbackProductStatus = Exclude<
  FeedbackProductStatus,
  'collecting'
>

export const FEEDBACK_PRODUCT_STATUSES = [
  { value: 'under_consideration', labelKey: 'status.under_consideration' },
  { value: 'planned', labelKey: 'status.planned' },
  { value: 'in_progress', labelKey: 'status.in_progress' },
  { value: 'released', labelKey: 'status.released' },
  { value: 'not_planned', labelKey: 'status.not_planned' },
] satisfies {
  value: PublicFeedbackProductStatus
  labelKey: string
}[]

const CATEGORY_LABEL_KEYS: Record<FeedbackCategory, string> = {
  bug: 'category.bug',
  idea: 'category.idea',
}

const AREA_LABEL_KEYS: Record<FeedbackArea, string> = {
  navigation: 'area.navigation',
  voice_video: 'area.voice_video',
  community: 'area.community',
  messages: 'area.messages',
  moderation: 'area.moderation',
  desktop: 'area.desktop',
  activities: 'area.activities',
  other: 'area.other',
}

const PLATFORM_LABELS: Record<FeedbackPlatform, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  web: 'Web',
  android: 'Android',
  ios: 'iOS',
}

export function feedbackCategoryLabel(
  category: FeedbackCategory,
  t: Translator,
) {
  return t(CATEGORY_LABEL_KEYS[category])
}

export function feedbackAreaLabel(area: FeedbackArea, t: Translator) {
  return t(AREA_LABEL_KEYS[area])
}

export function feedbackPlatformLabel(platform: FeedbackPlatform) {
  return PLATFORM_LABELS[platform]
}

export function feedbackProductStatusLabel(
  status: FeedbackProductStatus,
  t: Translator,
) {
  if (status === 'collecting') return null
  const entry = FEEDBACK_PRODUCT_STATUSES.find(
    (item) => item.value === status,
  )
  return entry ? t(entry.labelKey) : null
}

export function publicFeedbackStatus(
  status: FeedbackProductStatus,
): PublicFeedbackProductStatus | '' {
  return status === 'collecting' ? '' : status
}
