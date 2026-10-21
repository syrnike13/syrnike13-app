import { describe, expect, it } from 'vitest'
import { createTranslator } from '@syrnike13/ui/i18n'

import ru from '#/messages/ru.json'
import { FEEDBACK_AREAS, feedbackAreaLabel } from './feedback-meta'

const t = createTranslator(ru, 'ru', 'feedback.meta')

describe('feedback metadata', () => {
  it('offers the desktop area anywhere feedback areas are rendered', () => {
    expect(FEEDBACK_AREAS.map((item) => item.value)).toContain('desktop')
    expect(feedbackAreaLabel('desktop', t)).toBe('Десктопное приложение')
  })
})
