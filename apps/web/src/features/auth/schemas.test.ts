import { describe, expect, it } from 'vitest'

import { createRegisterSchema, usernameSchema, validateForm } from './schemas'

describe('createRegisterSchema', () => {
  it('accepts matching passwords', () => {
    const result = validateForm(createRegisterSchema({}), {
      email: 'user@example.com',
      password: 'password123',
      confirm: 'password123',
      invite: '',
    })

    expect(result.success).toBe(true)
  })

  it('reports a mismatched confirmation on the confirm field', () => {
    const result = validateForm(createRegisterSchema({}), {
      email: 'user@example.com',
      password: 'password123',
      confirm: 'password124',
      invite: '',
    })

    expect(result.success).toBe(false)
    if (result.success) return

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: 'Пароли не совпадают',
        path: ['confirm'],
      }),
    )
  })

  it('requires an invite only when the server is invite-only', () => {
    const result = validateForm(
      createRegisterSchema({ requireInvite: true }),
      {
      email: 'user@example.com',
      password: 'password123',
      confirm: 'password123',
      invite: '',
      },
    )

    expect(result.success).toBe(false)
    if (result.success) return

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: 'Нужен код приглашения',
        path: ['invite'],
      }),
    )
  })

  it('trims usernames before returning validated data', () => {
    const result = validateForm(usernameSchema, '  user_name  ')

    expect(result).toEqual({ success: true, data: 'user_name' })
  })
})
