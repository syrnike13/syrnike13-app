import { describe, expect, it, vi } from 'vitest'

import {
  createVoiceOperationId,
  isCurrentVoiceOperation,
} from './voice-operation'

describe('voice operation helpers', () => {
  it('creates unique operation ids with a voice prefix', () => {
    const first = createVoiceOperationId()
    const second = createVoiceOperationId()

    expect(first).toMatch(/^voice-op-/)
    expect(second).toMatch(/^voice-op-/)
    expect(first).not.toBe(second)
  })

  it('uses crypto randomUUID when available', () => {
    const randomUUID = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')

    expect(createVoiceOperationId()).toBe(
      'voice-op-00000000-0000-4000-8000-000000000001',
    )
    expect(randomUUID).toHaveBeenCalledTimes(1)

    randomUUID.mockRestore()
  })

  it('matches only exact current operation ids', () => {
    expect(isCurrentVoiceOperation('op-current', 'op-current')).toBe(true)
    expect(isCurrentVoiceOperation('op-current', 'op-stale')).toBe(false)
    expect(isCurrentVoiceOperation(null, 'op-current')).toBe(false)
    expect(isCurrentVoiceOperation('op-current', null)).toBe(false)
  })
})
