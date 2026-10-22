import { useEffect, useState, type ReactNode } from 'react'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'
import { Effect, Fiber } from 'effect'

import { GatewayLoadingScreen } from '#/components/layout/gateway-loading-screen'
import { usePlatform } from '#/platform/use-platform'
import type { DesktopUpdateState } from '@syrnike13/platform'

export function DesktopStartupUpdateGate({ children }: { children: ReactNode }) {
  const t = useTranslations('desktopUpdates')
  const { desktop } = usePlatform()
  const [state, setState] = useState<DesktopUpdateState | null>(null)
  const [startupSettled, setStartupSettled] = useState(false)

  useEffect(() => {
    if (!desktop) return

    const receiveState = (nextState: DesktopUpdateState) => {
      setState(nextState)
      if (nextState.status === 'idle' || nextState.status === 'error') {
        setStartupSettled(true)
      }
    }

    let pushedStateRevision = 0
    const receivePushedState = (nextState: DesktopUpdateState) => {
      pushedStateRevision += 1
      receiveState(nextState)
    }
    const unsubscribe = desktop.updates.onStateChange(receivePushedState)
    const initialRevision = pushedStateRevision
    const fiber = Effect.runFork(
      Effect.tryPromise({
        try: () => desktop.updates.getState(),
        catch: (cause) => cause,
      }).pipe(
        Effect.matchEffect({
          onFailure: () => Effect.sync(() => setStartupSettled(true)),
          onSuccess: (nextState) =>
            Effect.sync(() => {
              if (pushedStateRevision === initialRevision) {
                receiveState(nextState)
              }
            }),
        }),
      ),
    )

    return () => {
      unsubscribe()
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [desktop])

  if (!desktop || startupSettled) return children

  return (
    <GatewayLoadingScreen
      gatewayState="idle"
      statusText={startupUpdateStatus(state, t)}
    />
  )
}

function startupUpdateStatus(
  state: DesktopUpdateState | null,
  t: Translator,
) {
  if (!state || state.status === 'checking') return t('checking')

  switch (state.status) {
    case 'available':
      return t('preparing', { version: state.version })
    case 'downloading':
      return t('downloading', { percent: Math.round(state.percent) })
    case 'ready':
    case 'installing':
      return t('installing', { version: state.version })
    case 'idle':
    case 'error':
      return t('launching')
  }
}
