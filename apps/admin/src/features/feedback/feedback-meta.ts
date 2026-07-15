import type {
  FeedbackArea,
  FeedbackCategory,
  FeedbackPlatform,
  FeedbackProductStatus,
} from '@syrnike13/api-types'

export type PublicFeedbackProductStatus = Exclude<
  FeedbackProductStatus,
  'collecting'
>

export const FEEDBACK_PRODUCT_STATUSES = [
  { value: 'under_consideration', label: 'Рассматриваем' },
  { value: 'planned', label: 'Запланировано' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'released', label: 'Выпущено' },
  { value: 'not_planned', label: 'Не планируется' },
] satisfies {
  value: PublicFeedbackProductStatus
  label: string
}[]

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: 'Баг',
  idea: 'Идея',
}

const AREA_LABELS: Record<FeedbackArea, string> = {
  navigation: 'Навигация и интерфейс',
  voice_video: 'Голосовые и видео',
  community: 'Серверы и сообщества',
  messages: 'Сообщения и контент',
  moderation: 'Модерация и безопасность',
  desktop: 'Десктопное приложение',
  activities: 'Активности',
  other: 'Другое',
}

const PLATFORM_LABELS: Record<FeedbackPlatform, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  web: 'Web',
  android: 'Android',
  ios: 'iOS',
}

export function feedbackCategoryLabel(category: FeedbackCategory) {
  return CATEGORY_LABELS[category]
}

export function feedbackAreaLabel(area: FeedbackArea) {
  return AREA_LABELS[area]
}

export function feedbackPlatformLabel(platform: FeedbackPlatform) {
  return PLATFORM_LABELS[platform]
}

export function feedbackProductStatusLabel(status: FeedbackProductStatus) {
  if (status === 'collecting') return null
  return (
    FEEDBACK_PRODUCT_STATUSES.find((item) => item.value === status)?.label ??
    null
  )
}

export function publicFeedbackStatus(
  status: FeedbackProductStatus,
): PublicFeedbackProductStatus | '' {
  return status === 'collecting' ? '' : status
}
