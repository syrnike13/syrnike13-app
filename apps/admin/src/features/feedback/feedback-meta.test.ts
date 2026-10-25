import { createTranslator } from '@syrnike13/ui/i18n'
import { describe, expect, it } from 'vitest'

import en from '#/messages/en.json'
import ru from '#/messages/ru.json'
import {
  FEEDBACK_PRODUCT_STATUSES,
  feedbackAreaLabel,
  feedbackCategoryLabel,
  feedbackProductStatusLabel,
} from './feedback-meta'

const AREAS = [
  'navigation',
  'voice_video',
  'community',
  'messages',
  'moderation',
  'desktop',
  'activities',
  'other',
] as const

describe('feedback metadata', () => {
  it('resolves labels through the feedback.meta namespace', () => {
    const ruT = createTranslator(ru, 'ru', 'feedback.meta')
    const enT = createTranslator(en, 'en', 'feedback.meta')

    expect(feedbackCategoryLabel('bug', ruT)).toBe('Баг')
    expect(feedbackCategoryLabel('idea', enT)).toBe('Idea')
    expect(feedbackAreaLabel('desktop', ruT)).toBe('Десктопное приложение')

    for (const area of AREAS) {
      expect(ruT.has(`area.${area}`)).toBe(true)
      expect(enT.has(`area.${area}`)).toBe(true)
    }

    for (const status of FEEDBACK_PRODUCT_STATUSES) {
      expect(ruT.has(status.labelKey)).toBe(true)
      expect(enT.has(status.labelKey)).toBe(true)
      expect(feedbackProductStatusLabel(status.value, ruT)).toBeTypeOf('string')
    }
  })
})
