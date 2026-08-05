import { describe, expect, it } from 'vitest'

import { createRegisterSchema } from './schemas'

describe('createRegisterSchema', () => {
  it('accepts matching passwords', () => {
    const result = createRegisterSchema({}).safeParse({
      email: 'user@example.com',
      password: 'password123',
      confirm: 'password123',
      invite: '',
    })

    expect(result.success).toBe(true)
  })

  it('reports a mismatched confirmation on the confirm field', () => {
    const result = createRegisterSchema({}).safeParse({
      email: 'user@example.com',
      password: 'password123',
      confirm: 'password124',
      invite: '',
    })

    expect(result.success).toBe(false)
    if (result.success) return

    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        message: 'Пароли не совпадают',
        path: ['confirm'],
      }),
    )
  })

  it('requires an invite only when the server is invite-only', () => {
    const result = createRegisterSchema({ requireInvite: true }).safeParse({
      email: 'user@example.com',
      password: 'password123',
      confirm: 'password123',
      invite: '',
    })

    expect(result.success).toBe(false)
    if (result.success) return

    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        message: 'Нужен код приглашения',
        path: ['invite'],
      }),
    )
  })
})
