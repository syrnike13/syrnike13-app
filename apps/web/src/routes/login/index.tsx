import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { GatewayLoadingScreen } from '#/components/layout/gateway-loading-screen'
import { LoginForm } from '#/features/auth/login-form'
import { useAuth } from '#/features/auth/auth-context'
import { postLoginPath } from '#/lib/auth-post-login-path'
import { loadSession } from '#/lib/session'
import { isDesktopRuntime } from '#/platform/runtime'

export const Route = createFileRoute('/login/')({
  component: LoginPage,
})

function LoginPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [authChecked, setAuthChecked] = useState(false)

  useEffect(() => {
    if (!auth.hydrated) return

    const stored = isDesktopRuntime() ? auth.session : loadSession()
    if (stored || (auth.session && !auth.mfaChallenge)) {
      if (!auth.onboardingChecked) return
      void navigate({
        to: postLoginPath(auth.needsOnboarding),
        replace: true,
      })
      return
    }

    setAuthChecked(true)
  }, [
    auth.hydrated,
    auth.mfaChallenge,
    auth.needsOnboarding,
    auth.onboardingChecked,
    auth.session,
    navigate,
  ])

  const redirectingToApp =
    auth.hydrated &&
    ((isDesktopRuntime() ? Boolean(auth.session) : Boolean(loadSession())) ||
      (Boolean(auth.session) && !auth.mfaChallenge)) &&
    auth.onboardingChecked

  if (!auth.hydrated || !authChecked || redirectingToApp) {
    return <GatewayLoadingScreen gatewayState={auth.gatewayState} />
  }

  return (
    <div className="gradient-surface-content flex min-h-svh flex-col items-center justify-center bg-background px-6 py-12">
      <LoginForm />
    </div>
  )
}
