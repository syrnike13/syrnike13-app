import { describe, expect, it } from 'vitest'

import { composerStateReducer } from './use-composer-state'

const initial = {
  scope: 'user:channel',
  composeValue: 'обычный черновик',
  editMessageId: null,
  editValue: '',
}

describe('composer state machine', () => {
  it('keeps the compose draft while editing and restores it on cancel', () => {
    const editing = composerStateReducer(initial, {
      type: 'edit',
      messageId: 'message',
      value: 'исходный текст',
    })
    const changed = composerStateReducer(editing, {
      type: 'value',
      value: 'изменённый текст',
    })
    const cancelled = composerStateReducer(changed, {
      type: 'edit',
      messageId: null,
    })

    expect(changed.composeValue).toBe('обычный черновик')
    expect(cancelled.composeValue).toBe('обычный черновик')
    expect(cancelled.editValue).toBe('')
  })

  it('loads an isolated draft and exits edit mode on scope change', () => {
    const editing = composerStateReducer(initial, {
      type: 'edit',
      messageId: 'message',
      value: 'edit',
    })
    const switched = composerStateReducer(editing, {
      type: 'scope',
      scope: 'user:other-channel',
      value: 'другой черновик',
    })

    expect(switched).toEqual({
      scope: 'user:other-channel',
      composeValue: 'другой черновик',
      editMessageId: null,
      editValue: '',
    })
  })
})
