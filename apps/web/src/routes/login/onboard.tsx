import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Loader2Icon } from '#/components/icons'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { useAuth } from '#/features/auth/auth-context'
import { usernameSchema } from '#/features/auth/schemas'
import { postLoginPath } from '#/lib/auth-post-login-path'
import { loadPersistedSession } from '#/lib/session'

export const Route = createFileRoute('/login/onboard')({
  beforeLoad: async () => {
    if (
      typeof window !== 'undefined' &&
      !(await loadPersistedSession())
    ) {
      throw redirect({ to: '/login' })
    }
  },
  component: OnboardPage,
})

function OnboardPage() {
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
      const parsed = usernameSchema.safeParse(value.username)
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? 'Проверьте ник')
        return
      }

      setSubmitting(true)
      try {
        await auth.completeOnboarding(parsed.data)
        void navigate({ to: postLoginPath(false), replace: true })
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Не удалось сохранить ник',
        )
      } finally {
        setSubmitting(false)
      }
    },
  })

  if (!auth.hydrated || !auth.session || !auth.onboardingChecked) {
    return (
      <div className="gradient-surface-content flex min-h-svh items-center justify-center bg-background">
        <Loader2Icon className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="gradient-surface-content flex min-h-svh flex-col items-center justify-center bg-background px-6 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Выберите ник</CardTitle>
          <CardDescription>
            По нему вас смогут найти. Позже можно изменить в настройках профиля.
          </CardDescription>
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
                  <Label htmlFor="onboard-username">Имя пользователя</Label>
                  <Input
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
              Продолжить
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
