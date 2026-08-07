import { createFileRoute, Link } from '@tanstack/react-router'
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
import { Button } from '#/components/ui/button'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { resendVerificationEffect } from '#/features/api/account-api'
import { resetEmailSchema, validateForm } from '#/features/auth/schemas'
import {
  isCaptchaRequired,
  isEmailVerificationEnabled,
  resolveHcaptchaSiteKey,
  useSyrnikeConfig,
} from '#/features/auth/use-syrnike-config'
import { setPendingVerifyEmail } from '#/lib/auth-verify-email'
import { loadSession } from '#/lib/session'

export const Route = createFileRoute('/login/resend')({
  beforeLoad: () => {
    if (loadSession()) {
      return
    }
  },
  component: ResendVerificationPage,
})

function ResendVerificationPage() {
  const configQuery = useSyrnikeConfig()
  const features = configQuery.data?.features
  const siteKey = resolveHcaptchaSiteKey(features)
  const captchaRequired = isCaptchaRequired(features)
  const captchaRef = useHcaptchaRef()
  const [submitting, setSubmitting] = useState(false)
  const navigate = Route.useNavigate()
  const emailDisabled =
    configQuery.isSuccess && !isEmailVerificationEnabled(features)

  const form = useForm({
    defaultValues: { email: '' },
    onSubmit: async ({ value }) => {
      const parsed = validateForm(resetEmailSchema, value)
      if (!parsed.success) {
        toast.error(parsed.issues[0]?.message ?? 'Проверьте email')
        return
      }

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

          yield* resendVerificationEffect({
            email: parsed.data.email,
            captcha: captcha ?? undefined,
          })
          yield* Effect.sync(() => {
            setPendingVerifyEmail(parsed.data.email)
            toast.success('Письмо отправлено повторно')
          })
          yield* Effect.tryPromise({
            try: () => navigate({ to: '/login/check', replace: true }),
            catch: (cause) => cause,
          })
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : 'Не удалось отправить письмо',
              )
            }),
          ),
          Effect.ensuring(Effect.sync(() => setSubmitting(false))),
        ),
      )
    },
  })

  if (emailDisabled) {
    return (
      <AuthLayout>
        <AuthCard>
          <CardHeader>
            <CardTitle>Подтверждение отключено</CardTitle>
            <CardDescription>
              Письмо не требуется — можно сразу войти или создать аккаунт.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-col gap-2">
            <Button className="w-full" asChild>
              <Link to="/login">Ко входу</Link>
            </Button>
          </CardFooter>
        </AuthCard>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <AuthCard>
        <CardHeader>
          <CardTitle>Отправить письмо снова</CardTitle>
          <CardDescription>
            Укажите email, который использовали при регистрации.
          </CardDescription>
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
                  <Label htmlFor="resend-email">Email</Label>
                  <Input
                    className="auth-input"
                    id="resend-email"
                    type="email"
                    autoComplete="email"
                    value={field.state.value}
                    onChange={(event) =>
                      field.handleChange(event.target.value)
                    }
                  />
                </div>
              )}
            </form.Field>
            {siteKey ? (
              <HCaptchaWidget siteKey={siteKey} captchaRef={captchaRef} />
            ) : null}
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <Loader2Icon className="animate-spin" data-icon="inline-start" />
              ) : null}
              Отправить письмо
            </Button>
            <p className="auth-secondary-action">
              <Link to="/login">Вернуться ко входу</Link>
            </p>
          </CardFooter>
        </form>
      </AuthCard>
    </AuthLayout>
  )
}
