import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Loader2Icon } from '#/components/icons'
import { useState } from 'react'
import { toast } from 'sonner'

import { AuthCard, AuthLayout } from '#/components/auth/auth-layout'
import { PasswordInput } from '#/components/auth/password-input'
import { Button } from '#/components/ui/button'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { Label } from '#/components/ui/label'
import { confirmPasswordReset } from '#/features/api/account-api'
import { resetPasswordSchema } from '#/features/auth/schemas'
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
  const { token } = Route.useParams()
  const [submitting, setSubmitting] = useState(false)

  const form = useForm({
    defaultValues: { password: '', confirm: '' },
    onSubmit: async ({ value }) => {
      const parsed = resetPasswordSchema.safeParse(value)
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? 'Проверьте поля')
        return
      }

      setSubmitting(true)
      try {
        await confirmPasswordReset(token, parsed.data.password)
        toast.success('Пароль обновлён')
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Не удалось сменить пароль',
        )
      } finally {
        setSubmitting(false)
      }
    },
  })

  return (
    <AuthLayout>
      <AuthCard>
        <CardHeader>
          <CardTitle>Придумайте новый пароль</CardTitle>
          <CardDescription>
            Он заменит старый пароль для этого аккаунта.
          </CardDescription>
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
                  <Label htmlFor="new-password">Пароль</Label>
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
                  <Label htmlFor="new-password-confirm">Повтор пароля</Label>
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
              Сохранить пароль
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
