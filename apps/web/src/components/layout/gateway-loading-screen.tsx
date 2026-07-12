import { useEffect, useState } from 'react'

import type { GatewayState } from '#/features/events/gateway'
import { APP_LOGO_SRC, APP_NAME } from '#/lib/brand'
import {
  GATEWAY_LOADING_FACTS,
  pickGatewayLoadingFact,
} from '#/lib/gateway-loading-facts'
import { cn } from '#/lib/utils'

/** Один и тот же текст на сервере и при первом рендере клиента — без hydration mismatch. */
const INITIAL_FACT = GATEWAY_LOADING_FACTS[0]

const STATUS_BY_STATE: Record<GatewayState, string> = {
  idle: 'Запуск',
  connecting: 'Подключение',
  connected: 'Синхронизация',
  disconnected: 'Переподключение',
  reconnecting: 'Переподключение',
}

type GatewayLoadingScreenProps = {
  gatewayState: GatewayState
}

export function GatewayLoadingScreen({
  gatewayState,
}: GatewayLoadingScreenProps) {
  const [visible, setVisible] = useState(false)
  const [fact, setFact] = useState<string>(INITIAL_FACT)
  const status = STATUS_BY_STATE[gatewayState]

  useEffect(() => {
    setFact(pickGatewayLoadingFact())
    const frame = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div
      className={cn(
        'fixed inset-0 z-[200] flex flex-col items-center justify-center overflow-hidden',
        'bg-background px-6 text-foreground transition-opacity duration-300',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={`${status}. ${fact}`}
    >
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <img
          src={APP_LOGO_SRC}
          alt={APP_NAME}
          width={112}
          height={112}
          className="gateway-logo-wobble size-28 object-contain"
          draggable={false}
        />

        <p className="mt-10 text-xs font-bold tracking-[0.12em] text-foreground uppercase">
          А вы знали?
        </p>

        <p className="mt-3 text-base leading-relaxed font-normal text-muted-foreground">
          {fact}
        </p>
      </div>

      <p className="sr-only">
        {status}…
      </p>
    </div>
  )
}
