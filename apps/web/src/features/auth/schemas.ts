import { Result, Schema, SchemaIssue } from 'effect'

const formatSchemaIssue = SchemaIssue.makeFormatterStandardSchemaV1()

export type FormValidationResult<A> =
  | { readonly success: true; readonly data: A }
  | {
      readonly success: false
      readonly issues: ReturnType<typeof formatSchemaIssue>['issues']
    }

export function validateForm<
  FormSchema extends Schema.ConstraintDecoder<unknown, never>,
>(
  schema: FormSchema,
  input: unknown,
): FormValidationResult<FormSchema['Type']> {
  const result = Schema.decodeUnknownResult(schema, { errors: 'all' })(input)
  if (Result.isSuccess(result)) {
    return { success: true, data: result.success }
  }
  return {
    success: false,
    issues: formatSchemaIssue(result.failure.issue).issues,
  }
}

const emailSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    { message: 'Введите корректный email' },
  ),
)

const requiredPasswordSchema = Schema.String.check(
  Schema.isMinLength(1).annotate({ message: 'Введите пароль' }),
)

const passwordSchema = Schema.String.check(
  Schema.isMinLength(8).annotate({ message: 'Минимум 8 символов' }),
)

const passwordConfirmationSchema = Schema.String.check(
  Schema.isMinLength(1).annotate({ message: 'Повторите пароль' }),
)

const matchingPasswords = Schema.makeFilter(
  (data: { readonly password: string; readonly confirm: string }) =>
    data.password === data.confirm
      ? undefined
      : { path: ['confirm'], issue: 'Пароли не совпадают' },
)

export const loginSchema = Schema.Struct({
  email: emailSchema,
  password: requiredPasswordSchema,
})

export type LoginFormValues = typeof loginSchema.Type

export const mfaPasswordSchema = Schema.Struct({
  password: requiredPasswordSchema,
})

export type MfaPasswordFormValues = typeof mfaPasswordSchema.Type

export const usernameSchema = Schema.Trim.check(
  Schema.isMinLength(2).annotate({ message: 'Минимум 2 символа' }),
  Schema.isMaxLength(32).annotate({ message: 'Максимум 32 символа' }),
  Schema.isPattern(/^[a-z0-9_]+$/i).annotate({
    message: 'Только латиница, цифры и подчёркивание',
  }),
)

export const registerSchema = Schema.Struct({
  email: emailSchema,
  password: passwordSchema,
  confirm: passwordConfirmationSchema,
  invite: Schema.optionalKey(Schema.String),
}).check(matchingPasswords)

export function createRegisterSchema(options: { requireInvite?: boolean }) {
  return options.requireInvite
    ? registerSchema.check(
        Schema.makeFilter((data) =>
          data.invite?.trim()
            ? undefined
            : { path: ['invite'], issue: 'Нужен код приглашения' },
        ),
      )
    : registerSchema
}

export const resetEmailSchema = Schema.Struct({
  email: emailSchema,
})

export const resetPasswordSchema = Schema.Struct({
  password: passwordSchema,
  confirm: passwordConfirmationSchema,
}).check(matchingPasswords)

export const profileSchema = Schema.Struct({
  display_name: Schema.String.check(
    Schema.isMaxLength(32).annotate({ message: 'Максимум 32 символа' }),
  ),
  status_text: Schema.String.check(
    Schema.isMaxLength(128).annotate({ message: 'Максимум 128 символов' }),
  ),
  bio: Schema.String.check(
    Schema.isMaxLength(2000).annotate({ message: 'Максимум 2000 символов' }),
  ),
})

export const friendRequestSchema = Schema.Struct({
  username: Schema.String.check(
    Schema.isMinLength(2).annotate({ message: 'Укажите username' }),
  ),
})
