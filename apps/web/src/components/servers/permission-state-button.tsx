import {
  PERMISSION_TRI_STATE_ORDER,
  type PermissionTriState,
} from '#/lib/server-permissions'
import { cn } from '#/lib/utils'

const STATE_LABELS: Record<PermissionTriState, string> = {
  neutral: 'Наследуется',
  allow: 'Разрешено',
  deny: 'Запрещено',
}

export function PermissionStateButton({
  label,
  state,
  disabled,
  allowedStates,
  onChange,
}: {
  label: string
  state: PermissionTriState
  disabled?: boolean
  allowedStates?: PermissionTriState[]
  onChange: (next: PermissionTriState) => void
}) {
  const stateOrder = PERMISSION_TRI_STATE_ORDER
  const allowed = allowedStates ?? stateOrder
  const hasNextState = stateOrder.some(
    (candidate) => candidate !== state && allowed.includes(candidate),
  )
  const isDisabled = Boolean(disabled || !hasNextState)

  function cycle() {
    if (isDisabled) return

    const index = stateOrder.indexOf(state)
    for (let offset = 1; offset <= stateOrder.length; offset += 1) {
      const next = stateOrder[(index + offset) % stateOrder.length]!
      if (allowed.includes(next)) {
        onChange(next)
        return
      }
    }
  }

  const stateLabel = STATE_LABELS[state]

  return (
    <button
      type="button"
      disabled={isDisabled}
      onClick={cycle}
      aria-label={`${label}: ${stateLabel.toLowerCase()}`}
      className={cn(
        'flex size-8 items-center justify-center rounded-md border text-xs font-semibold transition-colors',
        state === 'allow' &&
          'border-emerald-500/40 bg-emerald-500/15 text-emerald-400',
        state === 'deny' && 'border-red-500/40 bg-red-500/15 text-red-400',
        state === 'neutral' && 'border-border text-muted-foreground',
        isDisabled && 'cursor-not-allowed opacity-50',
      )}
      title={stateLabel}
    >
      {state === 'allow' ? '✓' : state === 'deny' ? '✕' : '—'}
    </button>
  )
}
