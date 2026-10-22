import { describe, expect, it } from 'vitest'

import { createAchievementQueue, type AchievementUnlock } from './achievement-queue'

function unlock(id: string): AchievementUnlock {
  return { id, badgeId: id, name: id, description: null, iconUrl: null }
}

describe('createAchievementQueue', () => {
  it('shows unlocks one at a time in arrival order', () => {
    const queue = createAchievementQueue()

    queue.enqueue([unlock('a'), unlock('b')])
    queue.enqueue([unlock('c')])

    expect(queue.getState().current?.id).toBe('a')
    queue.advance()
    expect(queue.getState().current?.id).toBe('b')
    queue.advance()
    expect(queue.getState().current?.id).toBe('c')
    queue.advance()
    expect(queue.getState().current).toBeNull()
  })

  it('skips unlocks that are already shown or waiting', () => {
    const queue = createAchievementQueue()

    queue.enqueue([unlock('a'), unlock('b'), unlock('b')])
    queue.enqueue([unlock('a'), unlock('b')])

    expect(queue.getState().current?.id).toBe('a')
    expect(queue.getState().pending.map((item) => item.id)).toEqual(['b'])
  })

  it('notifies subscribers only when the queue changes', () => {
    const queue = createAchievementQueue()
    let calls = 0
    queue.subscribe(() => {
      calls += 1
    })

    queue.enqueue([unlock('a')])
    queue.enqueue([unlock('a')])

    expect(calls).toBe(1)
  })
})
