import { useForm } from '@tanstack/react-form'
import { Link, useNavigate } from '@tanstack/react-router'
import { Loader2Icon } from '#/components/icons'
import { useState } from 'react'
import { toast } from 'sonner'

import { AuthCard } from '#/components/auth/auth-layout'
import { PasswordInput } from '#/components/auth/password-input'
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

import { useAuth } from './auth-context'
import { loginSchema, mfaPasswordSchema } from './schemas'
import {
  isEmailVerificationEnabled,
  useSyrnikeConfig,
} from './use-syrnike-config'
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
      <AuthCard>
        <CardHeader>
          <CardTitle>Подтвердите вход</CardTitle>
          <CardDescription>
            Для этого аккаунта включена дополнительная защита. Введите пароль
            ещё раз.
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
                  <PasswordInput
                    id="mfa-password"
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
          <CardFooter className="grid grid-cols-2 gap-3">
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
      </AuthCard>
    )
  }

  return (
    <AuthCard>
      <CardHeader>
        <CardTitle>Вход</CardTitle>
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
                  className="auth-input"
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
                <PasswordInput
                  id="password"
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
          <p className="auth-secondary-action">
            Впервые здесь?
            <Link
              to="/login/register"
            >
              Создать аккаунт
            </Link>
          </p>
          <div className="auth-support-links">
            <Link
              to="/login/reset"
            >
              Забыли пароль?
            </Link>
            {emailVerification ? (
              <Link
                to="/login/resend"
              >
                Не пришло письмо
              </Link>
            ) : null}
          </div>
        </CardFooter>
      </form>
    </AuthCard>
  )
}
