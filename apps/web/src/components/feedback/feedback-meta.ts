import type {
  FeedbackModerationStatus,
  FeedbackProductStatus,
} from '@syrnike13/api-types'

export const FEEDBACK_CATEGORIES = [
  { value: 'navigation', label: 'Навигация и интерфейс' },
  { value: 'voice_video', label: 'Голосовые и видео' },
  { value: 'community', label: 'Серверы и сообщества' },
  { value: 'messages', label: 'Сообщения и контент' },
  { value: 'moderation', label: 'Модерация и безопасность' },
  { value: 'mobile', label: 'Мобильное приложение' },
  { value: 'desktop', label: 'Десктопное приложение' },
  { value: 'other', label: 'Другое' },
] as const

export const FEEDBACK_PRODUCT_STATUSES: {
  value: FeedbackProductStatus
  label: string
}[] = [
  { value: 'collecting', label: 'Собираем голоса' },
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

export function feedbackCategoryLabel(category: string) {
  return (
    FEEDBACK_CATEGORIES.find((item) => item.value === category)?.label ??
    category
  )
}

export function feedbackProductStatusLabel(status: FeedbackProductStatus) {
  return (
    FEEDBACK_PRODUCT_STATUSES.find((item) => item.value === status)?.label ??
    status
  )
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
