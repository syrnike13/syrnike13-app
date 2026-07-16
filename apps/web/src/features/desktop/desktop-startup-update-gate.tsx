import { useEffect, useState, type ReactNode } from 'react'

import { GatewayLoadingScreen } from '#/components/layout/gateway-loading-screen'
import { usePlatform } from '#/platform/use-platform'
import type { DesktopUpdateState } from '@syrnike13/platform'

export function DesktopStartupUpdateGate({ children }: { children: ReactNode }) {
  const { desktop } = usePlatform()
  const [state, setState] = useState<DesktopUpdateState | null>(null)
  const [startupSettled, setStartupSettled] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false

    const receiveState = (nextState: DesktopUpdateState) => {
      if (cancelled) return
      setState(nextState)
      if (nextState.status === 'idle' || nextState.status === 'error') {
        setStartupSettled(true)
      }
    }

    void desktop.updates.getState().then(receiveState).catch(() => {
      if (!cancelled) setStartupSettled(true)
    })
    const unsubscribe = desktop.updates.onStateChange(receiveState)

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [desktop])

  if (!desktop || startupSettled) return children

  return (
    <GatewayLoadingScreen
      gatewayState="idle"
      statusText={startupUpdateStatus(state)}
    />
  )
}

function startupUpdateStatus(state: DesktopUpdateState | null) {
  if (!state || state.status === 'checking') return 'Проверка обновлений…'

  switch (state.status) {
    case 'available':
      return `Подготовка обновления v${state.version}…`
    case 'downloading':
      return `Загрузка обновления… ${Math.round(state.percent)}%`
    case 'ready':
    case 'installing':
      return `Установка обновления v${state.version}…`
    case 'idle':
    case 'error':
      return 'Запуск…'
  }
}
