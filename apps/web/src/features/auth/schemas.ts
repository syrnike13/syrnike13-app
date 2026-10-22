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
    { message: 'email' },
  ),
)

const requiredPasswordSchema = Schema.String.check(
  Schema.isMinLength(1).annotate({ message: 'passwordRequired' }),
)

const passwordSchema = Schema.String.check(
  Schema.isMinLength(8).annotate({ message: 'passwordMin' }),
)

const passwordConfirmationSchema = Schema.String.check(
  Schema.isMinLength(1).annotate({ message: 'passwordConfirm' }),
)

const matchingPasswords = Schema.makeFilter(
  (data: { readonly password: string; readonly confirm: string }) =>
    data.password === data.confirm
      ? undefined
      : { path: ['confirm'], issue: 'passwordsMismatch' },
)

export const loginSchema = Schema.Struct({
  email: emailSchema,
  password: requiredPasswordSchema,
})

export const mfaPasswordSchema = Schema.Struct({
  password: requiredPasswordSchema,
})

export const usernameSchema = Schema.Trim.check(
  Schema.isMinLength(2).annotate({ message: 'usernameMin' }),
  Schema.isMaxLength(32).annotate({ message: 'usernameMax' }),
  Schema.isPattern(/^[a-z0-9_]+$/i).annotate({
    message: 'usernamePattern',
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
            : { path: ['invite'], issue: 'inviteRequired' },
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
    Schema.isMaxLength(32).annotate({ message: 'displayNameMax' }),
  ),
  status_text: Schema.String.check(
    Schema.isMaxLength(128).annotate({ message: 'statusMax' }),
  ),
  bio: Schema.String.check(
    Schema.isMaxLength(2000).annotate({ message: 'bioMax' }),
  ),
})
