import { useTranslations } from '@syrnike13/ui/i18n'

import { WifiOffIcon } from '#/components/icons'
import { Spinner } from '@syrnike13/ui/primitives/spinner'

import { useAuth } from '#/features/auth/auth-context'
import { useSyncReady } from '@syrnike13/client/sync/sync-store'
import { cn } from '#/lib/utils'

export function ConnectionStatusBanner() {
  const t = useTranslations('layout.connection')
  const auth = useAuth()
  const ready = useSyncReady()
  const { gatewayState } = auth

  const degraded =
    ready &&
    (gatewayState === 'disconnected' || gatewayState === 'reconnecting')

  if (!degraded) return null

  const reconnecting = gatewayState === 'reconnecting'

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center gap-2 border-b px-3 py-1.5 text-xs',
        reconnecting
          ? 'border-warning/20 bg-warning/10 text-warning'
          : 'border-destructive/20 bg-destructive/10 text-destructive-foreground',
      )}
      role="status"
      aria-live="polite"
    >
      {reconnecting ? (
        <Spinner className="size-3.5" aria-hidden />
      ) : (
        <WifiOffIcon className="size-3.5" aria-hidden />
      )}
      <span>
        {reconnecting ? t('reconnecting') : t('offline')}
      </span>
    </div>
  )
}
