import { describe, expect, it } from 'vitest'

import { voiceJoinErrorMessage } from './voice-join'
import { ApiError } from '#/lib/api/client'

describe('voiceJoinErrorMessage', () => {
  it('maps rate limit errors', () => {
    expect(voiceJoinErrorMessage(new ApiError('rate', 429))).toContain(
      'Слишком много запросов',
    )
  })

  it('maps unavailable channel errors', () => {
    expect(voiceJoinErrorMessage(new ApiError('bad', 400))).toBe(
      'Голос недоступен в этом канале',
    )
  })

  it('falls back to generic message', () => {
    expect(voiceJoinErrorMessage('boom')).toBe(
      'Не удалось подключиться к голосу',
    )
  })
})
