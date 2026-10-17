import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useForm } from '@tanstack/react-form'
import { Loader2Icon } from '#/components/icons'
import { useState } from 'react'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { AuthCard, AuthLayout } from '#/components/auth/auth-layout'
import { PasswordInput } from '#/components/auth/password-input'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import { Label } from '@syrnike13/ui/primitives/label'
import { confirmPasswordResetEffect } from '#/features/api/account-api'
import { resetPasswordSchema, validateForm } from '#/features/auth/schemas'
import { loadSession } from '#/lib/session'

export const Route = createFileRoute('/login/reset/$token')({
  beforeLoad: () => {
    if (loadSession()) {
      throw redirect({ to: '/app', search: { tab: 'online' } })
    }
  },
  component: ResetConfirmPage,
})

function ResetConfirmPage() {
  const t = useTranslations('auth')
  const tv = useTranslations('validation')
  const { token } = Route.useParams()
  const [submitting, setSubmitting] = useState(false)

  const form = useForm({
    defaultValues: { password: '', confirm: '' },
    onSubmit: async ({ value }) => {
      const parsed = validateForm(resetPasswordSchema, value)
      if (!parsed.success) {
        toast.error(tv(parsed.issues[0]?.message ?? 'fields'))
        return
      }

      setSubmitting(true)
      await Effect.runPromise(
        confirmPasswordResetEffect(token, parsed.data.password, true).pipe(
          Effect.tap(() =>
            Effect.sync(() => toast.success(t('reset.updated'))),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : t('reset.updateError'),
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
          <CardTitle>{t('reset.confirmTitle')}</CardTitle>
          <CardDescription>{t('reset.confirmDescription')}</CardDescription>
        </CardHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
        >
          <CardContent className="flex flex-col gap-4">
            <form.Field name="password">
              {(field) => (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="new-password">{t('passwordLabel')}</Label>
                  <PasswordInput
                    id="new-password"
                    autoComplete="new-password"
                    value={field.state.value}
                    onChange={(event) =>
                      field.handleChange(event.target.value)
                    }
                  />
                </div>
              )}
            </form.Field>
            <form.Field name="confirm">
              {(field) => (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="new-password-confirm">
                    {t('confirmPassword')}
                  </Label>
                  <PasswordInput
                    id="new-password-confirm"
                    autoComplete="new-password"
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
              {t('reset.confirmSubmit')}
            </Button>
            <p className="auth-secondary-action">
              <Link to="/login">{t('backToLogin')}</Link>
            </p>
          </CardFooter>
        </form>
      </AuthCard>
    </AuthLayout>
  )
}
