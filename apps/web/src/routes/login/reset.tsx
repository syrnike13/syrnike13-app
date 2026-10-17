import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useForm } from '@tanstack/react-form'
import { Loader2Icon } from '#/components/icons'
import { useState } from 'react'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { AuthCard, AuthLayout } from '#/components/auth/auth-layout'
import {
  Button,
  buttonVariants,
} from '@syrnike13/ui/primitives/button'
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
import { sendPasswordResetEffect } from '#/features/api/account-api'
import { resetEmailSchema, validateForm } from '#/features/auth/schemas'
import { loadSession } from '#/lib/session'

export const Route = createFileRoute('/login/reset')({
  beforeLoad: () => {
    if (loadSession()) {
      throw redirect({ to: '/app', search: { tab: 'online' } })
    }
  },
  component: ResetRequestPage,
})

function ResetRequestPage() {
  const t = useTranslations('auth')
  const tv = useTranslations('validation')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  const form = useForm({
    defaultValues: { email: '' },
    onSubmit: async ({ value }) => {
      const parsed = validateForm(resetEmailSchema, value)
      if (!parsed.success) {
        toast.error(tv(parsed.issues[0]?.message ?? 'email'))
        return
      }

      setSubmitting(true)
      await Effect.runPromise(
        sendPasswordResetEffect(parsed.data.email).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              setSent(true)
              toast.success(t('reset.sent'))
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              toast.error(
                error instanceof Error ? error.message : t('reset.error'),
              )
            }),
          ),
          Effect.ensuring(Effect.sync(() => setSubmitting(false))),
        ),
      )
    },
  })

  return (
    <AuthLayout>
      <AuthCard>
        <CardHeader>
          <CardTitle>
            {sent ? t('reset.sentTitle') : t('reset.title')}
          </CardTitle>
          <CardDescription>
            {sent ? t('reset.sentDescription') : t('reset.description')}
          </CardDescription>
        </CardHeader>
        {sent ? (
          <CardFooter>
            <Link to="/login" className={cn(buttonVariants(), 'w-full')}>
              {t('toLogin')}
            </Link>
          </CardFooter>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void form.handleSubmit()
            }}
          >
            <CardContent>
              <form.Field name="email">
                {(field) => (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="reset-email">{t('email')}</Label>
                    <Input
                      className="auth-input"
                      id="reset-email"
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
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? (
                  <Loader2Icon className="animate-spin" data-icon="inline-start" />
                ) : null}
                {t('reset.submit')}
              </Button>
              <p className="auth-secondary-action">
                {t('reset.remembered')}{' '}
                <Link to="/login">{t('backToLogin')}</Link>
              </p>
            </CardFooter>
          </form>
        )}
      </AuthCard>
    </AuthLayout>
  )
}
