import { useForm } from '@tanstack/react-form'
import { Link, useNavigate } from '@tanstack/react-router'
import { Loader2Icon } from 'lucide-react'
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

import { useAuth } from './auth-context'
import { loginSchema, mfaPasswordSchema } from './schemas'
import {
  isEmailVerificationEnabled,
  useSyrnikeConfig,
} from './use-syrnike-config'
import { config as appConfig } from '#/lib/config'
import { postLoginPath } from '#/lib/auth-post-login-path'

export function LoginForm() {
  const auth = useAuth()
  const navigate = useNavigate()
  const configQuery = useSyrnikeConfig()
  const emailVerification = isEmailVerificationEnabled(
    configQuery.data?.features,
  )
  const [submitting, setSubmitting] = useState(false)

  const loginForm = useForm({
    defaultValues: { email: '', password: '' },
    onSubmit: async ({ value }) => {
      const parsed = loginSchema.safeParse(value)
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? 'Проверьте поля')
        return
      }

      setSubmitting(true)
      try {
        const result = await auth.login(parsed.data)
        if (result && auth.session) {
          void navigate({
            to: postLoginPath(result.needsOnboarding),
            replace: true,
          })
        }
      } catch (error) {
        if (auth.session) return
        toast.error(
          error instanceof Error ? error.message : 'Не удалось войти',
        )
      } finally {
        setSubmitting(false)
      }
    },
  })

  const mfaForm = useForm({
    defaultValues: { password: '' },
    onSubmit: async ({ value }) => {
      const parsed = mfaPasswordSchema.safeParse(value)
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? 'Проверьте поля')
        return
      }

      setSubmitting(true)
      try {
        await auth.submitMfaPassword(parsed.data.password)
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Не удалось подтвердить MFA',
        )
      } finally {
        setSubmitting(false)
      }
    },
  })

  if (auth.mfaChallenge) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Двухфакторная аутентификация</CardTitle>
          <CardDescription>
            Подтвердите вход паролем. Доступные методы:{' '}
            {auth.mfaChallenge.allowedMethods.join(', ')}
          </CardDescription>
        </CardHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void mfaForm.handleSubmit()
          }}
        >
          <CardContent className="flex flex-col gap-4">
            <mfaForm.Field name="password">
              {(field) => (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="mfa-password">Пароль</Label>
                  <Input
                    id="mfa-password"
                    type="password"
                    autoComplete="current-password"
                    value={field.state.value}
                    onChange={(event) =>
                      field.handleChange(event.target.value)
                    }
                  />
                </div>
              )}
            </mfaForm.Field>
          </CardContent>
          <CardFooter className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={auth.cancelMfa}
              disabled={submitting}
            >
              Назад
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <Loader2Icon className="animate-spin" data-icon="inline-start" />
              ) : null}
              Подтвердить
            </Button>
          </CardFooter>
        </form>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Вход в syrnike13</CardTitle>
        <CardDescription>
          Используется API ({appConfig.apiUrl.replace(/^https?:\/\//, '')})
        </CardDescription>
      </CardHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void loginForm.handleSubmit()
        }}
      >
        <CardContent className="flex flex-col gap-4">
          <loginForm.Field name="email">
            {(field) => (
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </div>
            )}
          </loginForm.Field>
          <loginForm.Field name="password">
            {(field) => (
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Пароль</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </div>
            )}
          </loginForm.Field>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            ) : null}
            Войти
          </Button>
          <div className="flex w-full flex-col gap-2 text-center text-sm">
            <Link
              to="/login/register"
              className="text-primary underline-offset-4 hover:underline"
            >
              Создать аккаунт
            </Link>
            <Link
              to="/login/reset"
              className="text-muted-foreground underline-offset-4 hover:underline"
            >
              Забыли пароль?
            </Link>
            {emailVerification ? (
              <Link
                to="/login/resend"
                className="text-muted-foreground underline-offset-4 hover:underline"
              >
                Повторить письмо подтверждения
              </Link>
            ) : null}
          </div>
          <Button variant="ghost" className="w-full" asChild>
            <Link to="/">На главную</Link>
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
