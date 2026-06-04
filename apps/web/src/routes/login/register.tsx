import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Loader2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import {
  executeHcaptcha,
  HCaptchaWidget,
  useHcaptchaRef,
} from '#/components/auth/hcaptcha-widget'
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
import { createAccount } from '#/features/api/account-api'
import { useAuth } from '#/features/auth/auth-context'
import { createRegisterSchema } from '#/features/auth/schemas'
import {
  isCaptchaRequired,
  isEmailVerificationEnabled,
  isInviteOnlyRegistration,
  resolveHcaptchaSiteKey,
  useSyrnikeConfig,
} from '#/features/auth/use-syrnike-config'
import { postLoginPath } from '#/lib/auth-post-login-path'
import { setPendingVerifyEmail } from '#/lib/auth-verify-email'

export const Route = createFileRoute('/login/register')({
  component: RegisterPage,
})

function RegisterPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const configQuery = useSyrnikeConfig()
  const features = configQuery.data?.features
  const siteKey = resolveHcaptchaSiteKey(features)
  const captchaRequired = isCaptchaRequired(features)
  const inviteOnly = isInviteOnlyRegistration(features)
  const emailVerification = isEmailVerificationEnabled(features)
  const captchaRef = useHcaptchaRef()
  const [submitting, setSubmitting] = useState(false)
  const configReady = configQuery.isSuccess || configQuery.isError

  const form = useForm({
    defaultValues: { email: '', password: '', invite: '' },
    onSubmit: async ({ value }) => {
      if (!configReady) {
        toast.error('Подождите, загружаем настройки сервера…')
        return
      }

      const schema = createRegisterSchema({
        requireInvite: inviteOnly,
        requireCaptcha: captchaRequired,
      })
      const parsed = schema.safeParse(value)
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? 'Проверьте поля')
        return
      }

      let captcha: string | undefined
      if (captchaRequired) {
        if (!siteKey) {
          toast.error('Captcha не настроена на сервере')
          return
        }
        captcha = (await executeHcaptcha(captchaRef)) ?? undefined
        if (!captcha) {
          toast.error('Не удалось пройти captcha')
          return
        }
      }

      setSubmitting(true)
      try {
        try {
          await createAccount({
            email: parsed.data.email,
            password: parsed.data.password,
            invite: parsed.data.invite?.trim() || undefined,
            captcha,
          })
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : 'Не удалось зарегистрироваться',
          )
          return
        }

        if (emailVerification) {
          setPendingVerifyEmail(parsed.data.email)
          toast.success('Проверьте почту для подтверждения аккаунта')
          void navigate({ to: '/login/check', replace: true })
          return
        }

        const loginResult = await auth.login({
          email: parsed.data.email,
          password: parsed.data.password,
        })
        toast.success('Аккаунт создан')
        void navigate({
          to: postLoginPath(loginResult?.needsOnboarding ?? false),
          replace: true,
        })
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Не удалось зарегистрироваться',
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
          <CardTitle>Регистрация</CardTitle>
          <CardDescription>
            Создайте аккаунт на syrnike13.ru
            {inviteOnly ? ' — нужен код приглашения.' : null}
            {!emailVerification && configReady ? (
              <span className="mt-1 block text-muted-foreground">
                Подтверждение по почте на сервере отключено — после регистрации
                сразу выберете ник и войдёте.
              </span>
            ) : null}
          </CardDescription>
        </CardHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
        >
          <CardContent className="flex flex-col gap-4">
            <form.Field name="email">
              {(field) => (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="reg-email">Email</Label>
                  <Input
                    id="reg-email"
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
            <form.Field name="password">
              {(field) => (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="reg-password">Пароль</Label>
                  <Input
                    id="reg-password"
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
            <form.Field name="invite">
              {(field) => (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="reg-invite">
                    {inviteOnly
                      ? 'Код приглашения'
                      : 'Код приглашения (если нужен)'}
                  </Label>
                  <Input
                    id="reg-invite"
                    required={inviteOnly}
                    value={field.state.value}
                    onChange={(event) =>
                      field.handleChange(event.target.value)
                    }
                  />
                </div>
              )}
            </form.Field>
            {siteKey ? (
              <HCaptchaWidget siteKey={siteKey} captchaRef={captchaRef} />
            ) : null}
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button
              type="submit"
              className="w-full"
              disabled={submitting || !configReady}
            >
              {submitting || configQuery.isPending ? (
                <Loader2Icon className="animate-spin" data-icon="inline-start" />
              ) : null}
              Зарегистрироваться
            </Button>
            <Button variant="ghost" className="w-full" asChild>
              <Link to="/login">Уже есть аккаунт</Link>
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
