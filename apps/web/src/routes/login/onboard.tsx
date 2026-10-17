import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useForm } from '@tanstack/react-form'
import { Loader2Icon } from '#/components/icons'
import { useEffect, useState } from 'react'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { AuthCard, AuthLayout } from '#/components/auth/auth-layout'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import { useAuth } from '#/features/auth/auth-context'
import { usernameSchema, validateForm } from '#/features/auth/schemas'
import { postLoginPath } from '#/lib/auth-post-login-path'
import { loadPersistedSessionEffect } from '#/lib/session'

export const Route = createFileRoute('/login/onboard')({
  beforeLoad: async () => {
    if (
      typeof window !== 'undefined' &&
      !(await Effect.runPromise(loadPersistedSessionEffect()))
    ) {
      throw redirect({ to: '/login' })
    }
  },
  component: OnboardPage,
})

function OnboardPage() {
  const t = useTranslations('auth')
  const tv = useTranslations('validation')
  const auth = useAuth()
  const navigate = useNavigate()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!auth.hydrated || !auth.session) return
    if (!auth.onboardingChecked) return
    if (!auth.needsOnboarding) {
      void navigate({
        to: '/app',
        search: { tab: 'online' },
        replace: true,
      })
    }
  }, [
    auth.hydrated,
    auth.needsOnboarding,
    auth.onboardingChecked,
    auth.session,
    navigate,
  ])

  const form = useForm({
    defaultValues: { username: '' },
    onSubmit: async ({ value }) => {
      const parsed = validateForm(usernameSchema, value.username)
      if (!parsed.success) {
        toast.error(tv(parsed.issues[0]?.message ?? 'usernameMin'))
        return
      }

      setSubmitting(true)
      try {
        await Effect.runPromise(auth.completeOnboarding(parsed.data))
        void navigate({ to: postLoginPath(false), replace: true })
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t('onboard.error'),
        )
      } finally {
        setSubmitting(false)
      }
    },
  })

  if (!auth.hydrated || !auth.session || !auth.onboardingChecked) {
    return (
      <AuthLayout>
        <Loader2Icon className="size-8 animate-spin text-muted-foreground" />
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <AuthCard>
        <CardHeader>
          <CardTitle>{t('onboard.title')}</CardTitle>
          <CardDescription>{t('onboard.description')}</CardDescription>
        </CardHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
        >
          <CardContent>
            <form.Field name="username">
              {(field) => (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="onboard-username">{t('onboard.username')}</Label>
                  <Input
                    className="auth-input"
                    id="onboard-username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={field.state.value}
                    onChange={(event) =>
                      field.handleChange(event.target.value)
                    }
                  />
                </div>
              )}
            </form.Field>
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <Loader2Icon className="animate-spin" data-icon="inline-start" />
              ) : null}
              {t('onboard.submit')}
            </Button>
          </CardFooter>
        </form>
      </AuthCard>
    </AuthLayout>
  )
}
