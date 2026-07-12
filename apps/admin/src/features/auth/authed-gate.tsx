import { Navigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { useAuth } from './auth-context'

export function AuthedGate({ children }: { children: ReactNode }) {
  const auth = useAuth()

  if (!auth.hydrated || auth.isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background text-sm text-muted-foreground">
        Загрузка...
      </div>
    )
  }

  if (!auth.session) {
    return <Navigate to="/login" replace />
  }

  return children
}
