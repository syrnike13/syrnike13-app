import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Loader2Icon } from '#/components/icons'
import { useState } from 'react'
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
import { createAccount } from '#/features/api/account-api'
import { useAuth } from '#/features/auth/auth-context'
import { createRegisterSchema } from '#/features/auth/schemas'
import {
  isCaptchaRequired,
  isEmailVerificationEnabled,
  isInviteOnlyRegistration,
  resolveHcaptchaSiteKey,
  useSyrnikeConfig,
} from '#/features/auth/use-syrnike-config'
import { postLoginPath } from '#/lib/auth-post-login-path'
import { setPendingVerifyEmail } from '#/lib/auth-verify-email'

type RegisterFieldName = 'email' | 'password' | 'confirm' | 'invite'

const REGISTER_FIELD_IDS: Record<RegisterFieldName, string> = {
  email: 'reg-email',
  password: 'reg-password',
  confirm: 'reg-password-confirm',
  invite: 'reg-invite',
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
      const parsed = schema.safeParse(value)
      if (!parsed.success) {
        const nextErrors: Partial<Record<RegisterFieldName, string>> = {}
        let firstInvalidField: RegisterFieldName | undefined

        for (const issue of parsed.error.issues) {
          const fieldName = issue.path[0]
          if (
            typeof fieldName !== 'string' ||
            !(fieldName in REGISTER_FIELD_IDS)
          ) {
            continue
          }

          const registerField = fieldName as RegisterFieldName
          nextErrors[registerField] ??= issue.message
          firstInvalidField ??= registerField
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

      let captcha: string | undefined
      if (captchaRequired) {
        if (!siteKey) {
          toast.error('Captcha не настроена на сервере')
          return
        }
        captcha = (await executeHcaptcha(captchaRef)) ?? undefined
        if (!captcha) {
          toast.error('Не удалось пройти captcha')
          return
        }
      }

      setSubmitting(true)
      try {
        try {
          await createAccount({
            email: parsed.data.email,
            password: parsed.data.password,
            invite: parsed.data.invite?.trim() || undefined,
            captcha,
          })
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : 'Не удалось зарегистрироваться',
          )
          return
        }

        if (emailVerification) {
          setPendingVerifyEmail(parsed.data.email)
          toast.success('Проверьте почту для подтверждения аккаунта')
          void navigate({ to: '/login/check', replace: true })
          return
        }

        const loginResult = await auth.login({
          email: parsed.data.email,
          password: parsed.data.password,
        })
        toast.success('Аккаунт создан')
        void navigate({
          to: postLoginPath(loginResult?.needsOnboarding ?? false),
          replace: true,
        })
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Не удалось зарегистрироваться',
        )
      } finally {
        setSubmitting(false)
      }
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
            <form.Subscribe selector={(state) => state.values}>
              {(values) => {
                const canRegister =
                  configReady &&
                  createRegisterSchema({
                    requireInvite: inviteOnly,
                  }).safeParse(values).success

                return (
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={submitting || !canRegister}
                  >
                    {submitting || configQuery.isPending ? (
                      <Loader2Icon
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : null}
                    Зарегистрироваться
                  </Button>
                )
              }}
            </form.Subscribe>
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
