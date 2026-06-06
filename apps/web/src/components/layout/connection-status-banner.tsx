import { Loader2Icon, WifiOffIcon } from 'lucide-react'

import { useAuth } from '#/features/auth/auth-context'
import { useSyncReady } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

export function ConnectionStatusBanner() {
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
          ? 'border-amber-500/20 bg-amber-500/10 text-amber-100'
          : 'border-destructive/20 bg-destructive/10 text-destructive-foreground',
      )}
      role="status"
      aria-live="polite"
    >
      {reconnecting ? (
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <WifiOffIcon className="size-3.5" aria-hidden />
      )}
      <span>
        {reconnecting
          ? 'Восстанавливаем соединение…'
          : 'Нет связи с сервером. Повторная попытка…'}
      </span>
    </div>
  )
}
