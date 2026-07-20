import { describe, expect, it } from 'vitest'

import { FEEDBACK_AREAS, feedbackAreaLabel } from './feedback-meta'

describe('feedback metadata', () => {
  it('offers the desktop area anywhere feedback areas are rendered', () => {
    expect(FEEDBACK_AREAS.map((item) => item.value)).toContain('desktop')
    expect(feedbackAreaLabel('desktop')).toBe('Десктопное приложение')
  })
})
