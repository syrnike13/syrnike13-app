import type {
  FeedbackArea,
  FeedbackCategory,
  FeedbackModerationStatus,
  FeedbackPlatform,
  FeedbackProductStatus,
} from '@syrnike13/api-types'

export const FEEDBACK_CATEGORIES = [
  { value: 'bug', label: 'Баг', description: 'Что-то работает неправильно' },
  { value: 'idea', label: 'Идея', description: 'Предложение новой возможности' },
] satisfies { value: FeedbackCategory; label: string; description: string }[]

export const FEEDBACK_AREAS = [
  { value: 'navigation', label: 'Навигация и интерфейс' },
  { value: 'voice_video', label: 'Голосовые и видео' },
  { value: 'community', label: 'Серверы и сообщества' },
  { value: 'messages', label: 'Сообщения и контент' },
  { value: 'moderation', label: 'Модерация и безопасность' },
  { value: 'activities', label: 'Активности' },
  { value: 'other', label: 'Другое' },
] satisfies { value: FeedbackArea; label: string }[]

const FEEDBACK_AREA_LABELS: Record<FeedbackArea, string> = {
  navigation: 'Навигация и интерфейс',
  voice_video: 'Голосовые и видео',
  community: 'Серверы и сообщества',
  messages: 'Сообщения и контент',
  moderation: 'Модерация и безопасность',
  desktop: 'Десктопное приложение',
  activities: 'Активности',
  other: 'Другое',
}

export const FEEDBACK_PLATFORMS = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
  { value: 'web', label: 'Web' },
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
] satisfies { value: FeedbackPlatform; label: string }[]

export const FEEDBACK_PRODUCT_STATUSES: {
  value: FeedbackProductStatus
  label: string
}[] = [
  { value: 'under_consideration', label: 'Рассматриваем' },
  { value: 'planned', label: 'Запланировано' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'released', label: 'Выпущено' },
  { value: 'not_planned', label: 'Не планируется' },
]

export const FEEDBACK_MODERATION_LABELS: Record<
  FeedbackModerationStatus,
  string
> = {
  pending: 'На модерации',
  approved: 'Одобрено',
  rejected: 'Отклонено',
  merged: 'Объединено',
  hidden: 'Скрыто',
}

export function feedbackCategoryLabel(category: FeedbackCategory) {
  return (
    FEEDBACK_CATEGORIES.find((item) => item.value === category)?.label ??
    category
  )
}

export function feedbackAreaLabel(area: FeedbackArea) {
  return FEEDBACK_AREA_LABELS[area] ?? area
}

export function feedbackPlatformLabel(platform: FeedbackPlatform) {
  return FEEDBACK_PLATFORMS.find((item) => item.value === platform)?.label ?? platform
}

export function feedbackProductStatusLabel(status: FeedbackProductStatus) {
  if (status === 'collecting') return null
  return (
    FEEDBACK_PRODUCT_STATUSES.find((item) => item.value === status)?.label ??
    status
  )
}

export function feedbackCategoryClass(category: FeedbackCategory) {
  return category === 'bug'
    ? 'border-destructive/30 bg-destructive/8 text-destructive'
    : 'border-primary/30 bg-primary/8 text-primary'
}

export function feedbackStatusClass(status: FeedbackProductStatus) {
  switch (status) {
    case 'in_progress':
    case 'released':
      return 'border-chart-3/35 bg-chart-3/10 text-chart-3'
    case 'planned':
      return 'border-chart-4/35 bg-chart-4/10 text-chart-4'
    case 'not_planned':
      return 'border-destructive/35 bg-destructive/10 text-destructive'
    case 'collecting':
    case 'under_consideration':
      return 'border-chart-2/35 bg-chart-2/10 text-chart-2'
  }
}

export function feedbackModerationClass(status: FeedbackModerationStatus) {
  switch (status) {
    case 'approved':
      return 'border-chart-3/35 bg-chart-3/10 text-chart-3'
    case 'pending':
      return 'border-chart-2/35 bg-chart-2/10 text-chart-2'
    case 'rejected':
      return 'border-destructive/35 bg-destructive/10 text-destructive'
    case 'merged':
    case 'hidden':
      return 'border-border bg-muted/30 text-muted-foreground'
  }
}
