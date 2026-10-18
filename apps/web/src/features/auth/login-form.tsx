import { useForm } from '@tanstack/react-form'
import { Link, useNavigate } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useRef, useState } from 'react'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { AuthCard } from '#/components/auth/auth-layout'
import { PasswordInput } from '#/components/auth/password-input'
import { Button } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'

import { useAuth } from './auth-context'
import { loginSchema, mfaPasswordSchema, validateForm } from './schemas'
import {
  isEmailVerificationEnabled,
  useSyrnikeConfig,
} from './use-syrnike-config'
import { postLoginPath } from '#/lib/auth-post-login-path'
import { apiErrorMessage } from '#/lib/api/error-message'

export function LoginForm() {
  const auth = useAuth()
  const navigate = useNavigate()
  const t = useTranslations('auth')
  const tValidation = useTranslations('validation')
  const configQuery = useSyrnikeConfig()
  const emailVerification = isEmailVerificationEnabled(
    configQuery.data?.features,
  )
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const [submitting, setSubmitting] = useState(false)

  const loginForm = useForm({
    defaultValues: { email: '', password: '' },
    onSubmit: async ({ value }) => {
      const parsed = validateForm(loginSchema, value)
      if (!parsed.success) {
        toast.error(tValidation(parsed.issues[0]?.message ?? 'fields'))
        return
      }

      setSubmitting(true)
      try {
        const result = await Effect.runPromise(auth.login(parsed.data))
        if (result && auth.session) {
          void navigate({
            to: postLoginPath(result.needsOnboarding),
            replace: true,
          })
        }
      } catch (error) {
        if (auth.session) return
        toast.error(
          apiErrorMessage(error, t('login.error')),
        )
      } finally {
        setSubmitting(false)
      }
    },
  })

  const mfaForm = useForm({
    defaultValues: { password: '' },
    onSubmit: async ({ value }) => {
      const parsed = validateForm(mfaPasswordSchema, value)
      if (!parsed.success) {
        toast.error(tValidation(parsed.issues[0]?.message ?? 'fields'))
        return
      }

      setSubmitting(true)
      try {
        await Effect.runPromise(
          auth.submitMfaPassword(parsed.data.password),
        )
      } catch (error) {
        toast.error(
          apiErrorMessage(error, t('mfa.error')),
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
          <CardTitle>{t('mfa.title')}</CardTitle>
          <CardDescription>{t('mfa.description')}</CardDescription>
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
                  <Label htmlFor="mfa-password">{t('passwordLabel')}</Label>
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
              {t('back')}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              {t('confirm')}
            </Button>
          </CardFooter>
        </form>
      </AuthCard>
    )
  }

  return (
    <AuthCard>
      <CardHeader>
        <CardTitle>{t('login.title')}</CardTitle>
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
                <Label htmlFor="email">{t('email')}</Label>
                <Input
                  className="auth-input"
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key !== 'Enter'
                      || passwordInputRef.current?.value
                    ) {
                      return
                    }
                    event.preventDefault()
                    passwordInputRef.current?.focus()
                  }}
                />
              </div>
            )}
          </loginForm.Field>
          <loginForm.Field name="password">
            {(field) => (
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">{t('passwordLabel')}</Label>
                <PasswordInput
                  ref={passwordInputRef}
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
              <Spinner data-icon="inline-start" />
            ) : null}
            {t('login.submit')}
          </Button>
          <p className="auth-secondary-action">
            {t('login.firstTime')}
            <Link to="/login/register">{t('login.createAccount')}</Link>
          </p>
          <div className="auth-support-links">
            <Link to="/login/reset">{t('login.forgotPassword')}</Link>
            {emailVerification ? (
              <Link to="/login/resend">{t('login.resend')}</Link>
            ) : null}
          </div>
        </CardFooter>
      </form>
    </AuthCard>
  )
}
