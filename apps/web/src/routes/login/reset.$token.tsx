import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Loader2Icon } from '#/components/icons'
import { useState } from 'react'
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
import { confirmPasswordReset } from '#/features/api/account-api'
import { resetPasswordSchema } from '#/features/auth/schemas'
import { loadSession } from '#/lib/session'

export const Route = createFileRoute('/login/reset/$token')({
  beforeLoad: () => {
    if (loadSession()) {
      throw redirect({ to: '/app' })
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
    <div className="flex min-h-svh flex-col items-center justify-center bg-background px-6 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Новый пароль</CardTitle>
          <CardDescription>Введите пароль для аккаунта</CardDescription>
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
                  <Input
                    id="new-password"
                    type="password"
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
                  <Input
                    id="new-password-confirm"
                    type="password"
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
            <Button variant="ghost" className="w-full" asChild>
              <Link to="/login">Ко входу</Link>
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
