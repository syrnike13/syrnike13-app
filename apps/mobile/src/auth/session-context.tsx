import { createContext, useContext } from 'react'

import type { Session } from './session'

type SessionContextValue = { session: Session; logout: () => void }

export const SessionContext = createContext<SessionContextValue | null>(null)

/** The signed-in session; screens under the app layout always have one. */
export function useSession() {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession must be used inside SessionContext')
  return value
}
