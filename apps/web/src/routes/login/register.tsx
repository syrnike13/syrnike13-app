import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Loader2Icon } from '#/components/icons'
import { useState } from 'react'
import { Effect } from 'effect'
import { toast } from 'sonner'

import {
  executeHcaptcha,
  HCaptchaWidget,
  useHcaptchaRef,
} from '#/components/auth/hcaptcha-widget'
import { AuthCard, AuthLayout } from '#/components/auth/auth-layout'
import { PasswordInput } from '#/components/auth/password-input'
import { Button } from '#/components/ui/button'
import {
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { createAccountEffect } from '#/features/api/account-api'
import { useAuth } from '#/features/auth/auth-context'
import {
  createRegisterSchema,
  validateForm,
} from '#/features/auth/schemas'
import {
  isCaptchaRequired,
  isEmailVerificationEnabled,
  isInviteOnlyRegistration,
  resolveHcaptchaSiteKey,
  useSyrnikeConfig,
} from '#/features/auth/use-syrnike-config'
import { postLoginPath } from '#/lib/auth-post-login-path'
import { setPendingVerifyEmail } from '#/lib/auth-verify-email'

const REGISTER_FIELD_NAMES = [
  'email',
  'password',
  'confirm',
  'invite',
] as const satisfies readonly string[]

type RegisterFieldName = (typeof REGISTER_FIELD_NAMES)[number]

const REGISTER_FIELD_IDS = {
  email: 'reg-email',
  password: 'reg-password',
  confirm: 'reg-password-confirm',
  invite: 'reg-invite',
} as const satisfies Record<RegisterFieldName, string>

function isRegisterFieldName(value: unknown): value is RegisterFieldName {
  return (
    typeof value === 'string' &&
    REGISTER_FIELD_NAMES.some((fieldName) => fieldName === value)
  )
}

export const Route = createFileRoute('/login/register')({
  component: RegisterPage,
})

function RegisterPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const configQuery = useSyrnikeConfig()
  const features = configQuery.data?.features
  const siteKey = resolveHcaptchaSiteKey(features)
  const captchaRequired = isCaptchaRequired(features)
  const inviteOnly = isInviteOnlyRegistration(features)
  const emailVerification = isEmailVerificationEnabled(features)
  const captchaRef = useHcaptchaRef()
  const [submitting, setSubmitting] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<RegisterFieldName, string>>
  >({})
  const configReady = configQuery.isSuccess || configQuery.isError

  const form = useForm({
    defaultValues: { email: '', password: '', confirm: '', invite: '' },
    onSubmit: async ({ value }) => {
      if (!configReady) {
        toast.error('Подождите, загружаем настройки сервера…')
        return
      }

      const schema = createRegisterSchema({
        requireInvite: inviteOnly,
      })
      const parsed = validateForm(schema, value)
      if (!parsed.success) {
        const nextErrors: Partial<Record<RegisterFieldName, string>> = {}
        let firstInvalidField: RegisterFieldName | undefined

        for (const issue of parsed.issues) {
          const fieldName = issue.path?.[0]
          if (!isRegisterFieldName(fieldName)) continue

          nextErrors[fieldName] ??= issue.message
          firstInvalidField ??= fieldName
        }

        setFieldErrors(nextErrors)
        if (firstInvalidField) {
          document.getElementById(
            REGISTER_FIELD_IDS[firstInvalidField],
          )?.focus()
        }
        return
      }

      setFieldErrors({})

      if (captchaRequired && !siteKey) {
        toast.error('Captcha не настроена на сервере')
        return
      }

      setSubmitting(true)
      await Effect.runPromise(
        Effect.gen(function*() {
          const captcha = captchaRequired
            ? yield* Effect.tryPromise({
                try: () => executeHcaptcha(captchaRef),
                catch: (cause) => cause,
              })
            : undefined
          if (captchaRequired && !captcha) {
            return yield* Effect.fail(
              new Error('Не удалось пройти captcha'),
            )
          }

          yield* createAccountEffect({
            email: parsed.data.email,
            password: parsed.data.password,
            invite: parsed.data.invite?.trim() || undefined,
            captcha: captcha ?? undefined,
          })

          if (emailVerification) {
            yield* Effect.sync(() => {
              setPendingVerifyEmail(parsed.data.email)
              toast.success('Проверьте почту для подтверждения аккаунта')
            })
            yield* Effect.tryPromise({
              try: () => navigate({ to: '/login/check', replace: true }),
              catch: (cause) => cause,
            })
            return
          }

          const loginResult = yield* auth.login({
            email: parsed.data.email,
            password: parsed.data.password,
          })
          yield* Effect.sync(() => toast.success('Аккаунт создан'))
          yield* Effect.tryPromise({
            try: () =>
              navigate({
                to: postLoginPath(loginResult?.needsOnboarding ?? false),
                replace: true,
              }),
            catch: (cause) => cause,
          })
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : 'Не удалось зарегистрироваться',
              )
            }),
          ),
          Effect.ensuring(Effect.sync(() => setSubmitting(false))),
        ),
      )
    },
  })

  function clearFieldError(...fields: RegisterFieldName[]) {
    setFieldErrors((current) => {
      if (!fields.some((field) => current[field])) return current

      const next = { ...current }
      for (const field of fields) delete next[field]
      return next
    })
  }

  return (
    <AuthLayout>
      <AuthCard>
        <CardHeader>
          <CardTitle>Создать аккаунт</CardTitle>
        </CardHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
        >
          <CardContent className="flex flex-col gap-4">
            <form.Field name="email">
              {(field) => (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="reg-email">Email</Label>
                  <Input
                    className="auth-input"
                    id="reg-email"
                    type="email"
                    autoComplete="email"
                    aria-invalid={Boolean(fieldErrors.email)}
                    aria-describedby={
                      fieldErrors.email ? 'reg-email-error' : undefined
                    }
                    value={field.state.value}
                    onChange={(event) => {
                      clearFieldError('email')
                      field.handleChange(event.target.value)
                    }}
                  />
                  <RegisterFieldError
                    id="reg-email-error"
                    message={fieldErrors.email}
                  />
                </div>
              )}
            </form.Field>
            <form.Field name="password">
              {(field) => (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="reg-password">Пароль</Label>
                  <PasswordInput
                    id="reg-password"
                    autoComplete="new-password"
                    aria-invalid={Boolean(fieldErrors.password)}
                    aria-describedby={
                      fieldErrors.password ? 'reg-password-error' : undefined
                    }
                    value={field.state.value}
                    onChange={(event) => {
                      clearFieldError('password', 'confirm')
                      field.handleChange(event.target.value)
                    }}
                  />
                  <RegisterFieldError
                    id="reg-password-error"
                    message={fieldErrors.password}
                  />
                </div>
              )}
            </form.Field>
            <form.Field name="confirm">
              {(field) => (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="reg-password-confirm">
                    Повторите пароль
                  </Label>
                  <PasswordInput
                    id="reg-password-confirm"
                    autoComplete="new-password"
                    aria-invalid={Boolean(fieldErrors.confirm)}
                    aria-describedby={
                      fieldErrors.confirm
                        ? 'reg-password-confirm-error'
                        : undefined
                    }
                    value={field.state.value}
                    onChange={(event) => {
                      clearFieldError('confirm')
                      field.handleChange(event.target.value)
                    }}
                  />
                  <RegisterFieldError
                    id="reg-password-confirm-error"
                    message={fieldErrors.confirm}
                  />
                </div>
              )}
            </form.Field>
            {inviteOnly ? (
              <form.Field name="invite">
                {(field) => (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="reg-invite">Код приглашения</Label>
                    <Input
                      className="auth-input"
                      id="reg-invite"
                      required
                      aria-invalid={Boolean(fieldErrors.invite)}
                      aria-describedby={
                        fieldErrors.invite ? 'reg-invite-error' : undefined
                      }
                      value={field.state.value}
                      onChange={(event) => {
                        clearFieldError('invite')
                        field.handleChange(event.target.value)
                      }}
                    />
                    <RegisterFieldError
                      id="reg-invite-error"
                      message={fieldErrors.invite}
                    />
                  </div>
                )}
              </form.Field>
            ) : null}
            {siteKey ? (
              <HCaptchaWidget siteKey={siteKey} captchaRef={captchaRef} />
            ) : null}
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button
              type="submit"
              className="w-full"
              disabled={submitting || !configReady}
            >
              {submitting || configQuery.isPending ? (
                <Loader2Icon
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : null}
              Зарегистрироваться
            </Button>
            <p className="auth-secondary-action">
              Уже с нами? <Link to="/login">Войти</Link>
            </p>
          </CardFooter>
        </form>
      </AuthCard>
    </AuthLayout>
  )
}

function RegisterFieldError({
  id,
  message,
}: {
  id: string
  message?: string
}) {
  if (!message) return null

  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  )
}
