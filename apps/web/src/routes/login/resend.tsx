import { createFileRoute, Link } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useForm } from '@tanstack/react-form'
import { useState } from 'react'
import { Effect } from 'effect'

import {
  executeHcaptcha,
  HCaptchaWidget,
  useHcaptchaRef,
} from '#/components/auth/hcaptcha-widget'
import { AuthCard, AuthLayout } from '#/components/auth/auth-layout'
import {
  Button,
  buttonVariants,
} from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { cn } from '#/lib/utils'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
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
  const t = useTranslations('auth')
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
        return
      }

      if (captchaRequired && !siteKey) {
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
              new Error(t('register.captchaFailed')),
            )
          }

          yield* resendVerificationEffect({
            email: parsed.data.email,
            captcha: captcha ?? undefined,
          })
          yield* Effect.sync(() => {
            setPendingVerifyEmail(parsed.data.email)
          })
          yield* Effect.tryPromise({
            try: () => navigate({ to: '/login/check', replace: true }),
            catch: (cause) => cause,
          })
        }).pipe(
          Effect.catch(() =>
            Effect.sync(() => {
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
            <CardTitle>{t('resend.disabledTitle')}</CardTitle>
            <CardDescription>
              {t('resend.disabledDescription')}
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-col gap-2">
            <Link to="/login" className={cn(buttonVariants(), 'w-full')}>
              {t('toLogin')}
            </Link>
          </CardFooter>
        </AuthCard>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <AuthCard>
        <CardHeader>
          <CardTitle>{t('resend.title')}</CardTitle>
          <CardDescription>{t('resend.description')}</CardDescription>
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
                  <Label htmlFor="resend-email">{t('email')}</Label>
                  <Input
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
            <Button type="submit" size="lg" className="w-full" disabled={submitting}>
              {submitting ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              {t('resend.submit')}
            </Button>
            <p className="auth-secondary-action">
              <Link to="/login">{t('resend.backToLogin')}</Link>
            </p>
          </CardFooter>
        </form>
      </AuthCard>
    </AuthLayout>
  )
}
