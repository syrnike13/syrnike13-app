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
import { sendPasswordReset } from '#/features/api/account-api'
import { resetEmailSchema } from '#/features/auth/schemas'
import { loadSession } from '#/lib/session'

export const Route = createFileRoute('/login/reset')({
  beforeLoad: () => {
    if (loadSession()) {
      throw redirect({ to: '/app' })
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
      const parsed = resetEmailSchema.safeParse(value)
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? 'Проверьте email')
        return
      }

      setSubmitting(true)
      try {
        await sendPasswordReset(parsed.data.email)
        setSent(true)
        toast.success('Если аккаунт существует, письмо отправлено')
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Не удалось отправить',
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
          <CardTitle>Сброс пароля</CardTitle>
          <CardDescription>
            {sent
              ? 'Проверьте почту и перейдите по ссылке из письма.'
              : 'На email придёт ссылка для нового пароля'}
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
                Отправить
              </Button>
              <Button variant="ghost" className="w-full" asChild>
                <Link to="/login">Назад</Link>
              </Button>
            </CardFooter>
          </form>
        )}
      </Card>
    </div>
  )
}
