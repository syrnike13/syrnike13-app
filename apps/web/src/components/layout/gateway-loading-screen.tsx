import { useTranslations } from '@syrnike13/ui/i18n'
import { useActiveHoliday } from '@syrnike13/ui/holidays'
import { useEffect, useState } from 'react'

import {
  CakeLogo,
  HALLOWEEN_CAKE_VARIANT,
  type CakeLogoVariant,
} from '#/components/layout/cake-logo'
import type { GatewayState } from '#/features/events/gateway'
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

export type GatewayLoadingScreenViewProps = {
  factTitle: string
  fact: string
  status: string
  /** Показывает строку статуса под фактом; на экране загрузки она необязательна. */
  showStatus?: boolean
  /** Enable motion only after the developer explicitly requests playback. */
  previewMotion?: boolean
  /** Seasonal scene for the logo; the gallery overrides it for previews. */
  logoVariant?: CakeLogoVariant
  className?: string
}

/**
 * Содержимое экрана загрузки без полноэкранной подложки: логотип, факт и
 * статус. Отдельный слой нужен dev-галерее, чтобы показывать экран внутри
 * карточки, а не поверх всего приложения.
 */
export function GatewayLoadingScreenView({
  factTitle,
  fact,
  status,
  showStatus = false,
  previewMotion,
  logoVariant = 'classic',
  className,
}: GatewayLoadingScreenViewProps) {
  return (
    <div
      className={cn(
        'flex size-full flex-col items-center justify-center px-6 text-center',
        className,
      )}
    >
      <div className="flex h-44 w-64 max-w-full items-center justify-center">
        <CakeLogo previewMotion={previewMotion} variant={logoVariant} />
      </div>

      <p className="mt-8 text-xs font-bold tracking-widest text-foreground uppercase">
        {factTitle}
      </p>

      <p className="mt-3 max-w-md text-base leading-relaxed font-normal text-muted-foreground">
        {fact}
      </p>

      {showStatus ? (
        <p className="mt-8 text-sm font-medium text-foreground">{status}</p>
      ) : null}
    </div>
  )
}

export function GatewayLoadingScreen({
  gatewayState,
  statusText,
}: GatewayLoadingScreenProps) {
  const t = useTranslations('layout.loading')
  const holiday = useActiveHoliday()
  const [visible, setVisible] = useState(false)
  const [factKey, setFactKey] = useState<string>(INITIAL_FACT_KEY)
  const status = statusText ?? t(STATUS_BY_STATE[gatewayState])
  const fact = t(factKey)
  const logoVariant =
    holiday?.id === 'halloween' ? HALLOWEEN_CAKE_VARIANT : 'classic'

  useEffect(() => {
    setFactKey(pickGatewayLoadingFactKey())
    const frame = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div
      className={cn(
        'fixed inset-0 z-200 flex flex-col items-center justify-center overflow-hidden',
        'gradient-surface-content bg-background text-foreground transition-opacity duration-300',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={`${status}. ${fact}`}
    >
      <GatewayLoadingScreenView
        factTitle={t('factTitle')}
        fact={fact}
        status={status}
        showStatus={Boolean(statusText)}
        logoVariant={logoVariant}
      />

      <p className="sr-only">{status}…</p>
    </div>
  )
}
