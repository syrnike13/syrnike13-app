import { useTranslations } from '@syrnike13/ui/i18n'
import { useEffect, useState } from 'react'

import type { GatewayState } from '#/features/events/gateway'
import { APP_LOGO_SRC, APP_NAME } from '#/lib/brand'
import {
  GATEWAY_LOADING_FACT_KEYS,
  pickGatewayLoadingFactKey,
} from '#/lib/gateway-loading-facts'
import { cn } from '#/lib/utils'

/** Один и тот же ключ на сервере и при первом рендере клиента — без hydration mismatch. */
const INITIAL_FACT_KEY = GATEWAY_LOADING_FACT_KEYS[0]

const STATUS_BY_STATE: Record<GatewayState, string> = {
  idle: 'status.idle',
  connecting: 'status.connecting',
  connected: 'status.connected',
  disconnected: 'status.disconnected',
  reconnecting: 'status.reconnecting',
}

type GatewayLoadingScreenProps = {
  gatewayState: GatewayState
  statusText?: string
}

export function GatewayLoadingScreen({
  gatewayState,
  statusText,
}: GatewayLoadingScreenProps) {
  const t = useTranslations('layout.loading')
  const [visible, setVisible] = useState(false)
  const [factKey, setFactKey] = useState<string>(INITIAL_FACT_KEY)
  const status = statusText ?? t(STATUS_BY_STATE[gatewayState])
  const fact = t(factKey)

  useEffect(() => {
    setFactKey(pickGatewayLoadingFactKey())
    const frame = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div
      className={cn(
        'fixed inset-0 z-200 flex flex-col items-center justify-center overflow-hidden',
        'gradient-surface-content bg-background px-6 text-foreground transition-opacity duration-300',
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

        <p className="mt-10 text-xs font-bold tracking-widest text-foreground uppercase">
          {t('factTitle')}
        </p>

        <p className="mt-3 text-base leading-relaxed font-normal text-muted-foreground">
          {fact}
        </p>

        {statusText ? (
          <p className="mt-8 text-sm font-medium text-foreground">{status}</p>
        ) : null}
      </div>

      <p className="sr-only">{status}…</p>
    </div>
  )
}
