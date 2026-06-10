import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Loader2Icon } from '#/components/icons'
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
import { resendVerification } from '#/features/api/account-api'
import { resetEmailSchema } from '#/features/auth/schemas'
import {
  isCaptchaRequired,
  isEmailVerificationEnabled,
  resolveHcaptchaSiteKey,
  useSyrnikeConfig,
} from '#/features/auth/use-syrnike-config'
import { setPendingVerifyEmail } from '#/lib/auth-verify-email'
import { loadSession } from '#/lib/session'

export const Route = createFileRoute('/login/resend')({
  beforeLoad: () => {
    if (loadSession()) {
      return
    }
  },
  component: ResendVerificationPage,
})

function ResendVerificationPage() {
  const configQuery = useSyrnikeConfig()
  const features = configQuery.data?.features
  const siteKey = resolveHcaptchaSiteKey(features)
  const captchaRequired = isCaptchaRequired(features)
  const captchaRef = useHcaptchaRef()
  const [submitting, setSubmitting] = useState(false)
  const navigate = Route.useNavigate()
  const emailDisabled =
    configQuery.isSuccess && !isEmailVerificationEnabled(features)

  const form = useForm({
    defaultValues: { email: '' },
    onSubmit: async ({ value }) => {
      const parsed = resetEmailSchema.safeParse(value)
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? 'Проверьте email')
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
        await resendVerification({
          email: parsed.data.email,
          captcha,
        })
        setPendingVerifyEmail(parsed.data.email)
        toast.success('Письмо отправлено повторно')
        void navigate({ to: '/login/check', replace: true })
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось отправить письмо',
        )
      } finally {
        setSubmitting(false)
      }
    },
  })

  if (emailDisabled) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center px-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Подтверждение отключено</CardTitle>
            <CardDescription>
              На этом сервере не требуется подтверждение email. Можно сразу
              войти или зарегистрироваться.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-col gap-2">
            <Button className="w-full" asChild>
              <Link to="/login">Ко входу</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background px-6 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Повторная отправка</CardTitle>
          <CardDescription>
            Отправим письмо с подтверждением ещё раз
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
                  <Label htmlFor="resend-email">Email</Label>
                  <Input
                    id="resend-email"
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
            {siteKey ? (
              <HCaptchaWidget siteKey={siteKey} captchaRef={captchaRef} />
            ) : null}
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
      </Card>
    </div>
  )
}
