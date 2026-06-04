import { z } from 'zod'

export const loginSchema = z.object({
  email: z.string().email('Введите корректный email'),
  password: z.string().min(1, 'Введите пароль'),
})

export type LoginFormValues = z.infer<typeof loginSchema>

export const mfaPasswordSchema = z.object({
  password: z.string().min(1, 'Введите пароль'),
})

export type MfaPasswordFormValues = z.infer<typeof mfaPasswordSchema>

export const usernameSchema = z
  .string()
  .trim()
  .min(2, 'Минимум 2 символа')
  .max(32, 'Максимум 32 символа')
  .regex(/^[a-z0-9_]+$/i, 'Только латиница, цифры и подчёркивание')

export const registerSchema = z.object({
  email: z.string().email('Введите корректный email'),
  password: z.string().min(8, 'Минимум 8 символов'),
  invite: z.string().optional(),
  captcha: z.string().optional(),
})

export function createRegisterSchema(options: {
  requireInvite?: boolean
  requireCaptcha?: boolean
}) {
  return registerSchema.superRefine((data, ctx) => {
    if (options.requireInvite && !data.invite?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'Нужен код приглашения',
        path: ['invite'],
      })
    }
    if (options.requireCaptcha && !data.captcha?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'Подтвердите captcha',
        path: ['captcha'],
      })
    }
  })
}

export const resetEmailSchema = z.object({
  email: z.string().email('Введите корректный email'),
})

export const resetPasswordSchema = z
  .object({
    password: z.string().min(8, 'Минимум 8 символов'),
    confirm: z.string().min(1, 'Повторите пароль'),
  })
  .refine((data) => data.password === data.confirm, {
    message: 'Пароли не совпадают',
    path: ['confirm'],
  })

export const profileSchema = z.object({
  display_name: z.string().max(32, 'Максимум 32 символа'),
  status_text: z.string().max(128, 'Максимум 128 символов'),
  bio: z.string().max(2000, 'Максимум 2000 символов'),
})

export const friendRequestSchema = z.object({
  username: z.string().min(2, 'Укажите username'),
})
