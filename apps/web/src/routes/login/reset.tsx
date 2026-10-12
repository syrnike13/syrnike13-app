import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Loader2Icon } from '#/components/icons'
import { useState } from 'react'
import { Effect } from 'effect'
import { toast } from 'sonner'

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
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  const form = useForm({
    defaultValues: { email: '' },
    onSubmit: async ({ value }) => {
      const parsed = validateForm(resetEmailSchema, value)
      if (!parsed.success) {
        toast.error(parsed.issues[0]?.message ?? 'Проверьте email')
        return
      }

      setSubmitting(true)
      await Effect.runPromise(
        sendPasswordResetEffect(parsed.data.email).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              setSent(true)
              toast.success('Если аккаунт существует, письмо отправлено')
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              toast.error(
                error instanceof Error ? error.message : 'Не удалось отправить',
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
          <CardTitle>{sent ? 'Письмо отправлено' : 'Вернуть доступ'}</CardTitle>
          <CardDescription>
            {sent
              ? 'Если такой аккаунт существует, ссылка для нового пароля уже в почте.'
              : 'Укажите email — отправим ссылку для нового пароля.'}
          </CardDescription>
        </CardHeader>
        {sent ? (
          <CardFooter>
            <Button className="w-full" asChild>
              <Link to="/login">Ко входу</Link>
            </Button>
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
                    <Label htmlFor="reset-email">Email</Label>
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
                Отправить ссылку
              </Button>
              <p className="auth-secondary-action">
                Вспомнили пароль? <Link to="/login">Вернуться ко входу</Link>
              </p>
            </CardFooter>
          </form>
        )}
      </AuthCard>
    </AuthLayout>
  )
}
