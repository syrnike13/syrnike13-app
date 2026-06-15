import { useEffect, useState } from 'react'

import type { GatewayState } from '#/features/events/gateway'
import {
  APP_LOADING_EASTER_EGG_SRC,
  APP_LOGO_SRC,
  APP_NAME,
} from '#/lib/brand'
import {
  GATEWAY_LOADING_FACTS,
  pickGatewayLoadingFact,
} from '#/lib/gateway-loading-facts'
import { cn } from '#/lib/utils'
import { useEasterMode } from '#/features/easter/easter-mode-store'

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
  const easterModeEnabled = useEasterMode()
  const [visible, setVisible] = useState(easterModeEnabled)
  const [easterAssetFailed, setEasterAssetFailed] = useState(false)
  const [fact, setFact] = useState<string>(INITIAL_FACT)
  const status = STATUS_BY_STATE[gatewayState]
  const showEasterEgg = easterModeEnabled && !easterAssetFailed

  useEffect(() => {
    setFact(pickGatewayLoadingFact())
    if (easterModeEnabled) {
      setVisible(true)
      return
    }

    const frame = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [easterModeEnabled])

  useEffect(() => {
    if (easterModeEnabled) setEasterAssetFailed(false)
  }, [easterModeEnabled])

  return (
    <div
      className={cn(
        'fixed inset-0 z-[200] flex flex-col items-center justify-center overflow-hidden',
        'bg-[#313338] px-6 text-[#f2f3f5] transition-opacity duration-300',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={`${status}. ${fact}`}
    >
      <div className="flex w-full max-w-[32rem] flex-col items-center text-center">
        {showEasterEgg ? (
          <img
            src={APP_LOADING_EASTER_EGG_SRC}
            alt={APP_NAME}
            width={512}
            height={512}
            className="size-[min(32rem,calc(100vw-3rem))] object-contain"
            draggable={false}
            onError={() => setEasterAssetFailed(true)}
          />
        ) : (
          <img
            src={APP_LOGO_SRC}
            alt={APP_NAME}
            width={112}
            height={112}
            className="gateway-logo-wobble size-28 object-contain"
            draggable={false}
          />
        )}

        <p className="mt-10 text-xs font-bold tracking-[0.12em] text-[#f2f3f5] uppercase">
          А вы знали?
        </p>

        <p className="mt-3 text-base leading-relaxed font-normal text-[#dbdee1]">
          {fact}
        </p>
      </div>

      <p className="sr-only">
        {status}…
      </p>
    </div>
  )
}
