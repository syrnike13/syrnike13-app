import type { PermissionTriState } from '#/lib/server-permissions'
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
  onChange,
}: {
  label: string
  state: PermissionTriState
  disabled?: boolean
  onChange: (next: PermissionTriState) => void
}) {
  function cycle() {
    if (disabled) return
    const order: PermissionTriState[] = ['neutral', 'allow', 'deny']
    const index = order.indexOf(state)
    onChange(order[(index + 1) % order.length]!)
  }

  const stateLabel = STATE_LABELS[state]

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={cycle}
      aria-label={`${label}: ${stateLabel.toLowerCase()}`}
      className={cn(
        'flex size-8 items-center justify-center rounded-md border text-xs font-semibold transition-colors',
        state === 'allow' &&
          'border-emerald-500/40 bg-emerald-500/15 text-emerald-400',
        state === 'deny' && 'border-red-500/40 bg-red-500/15 text-red-400',
        state === 'neutral' && 'border-border text-muted-foreground',
        disabled && 'cursor-not-allowed opacity-50',
      )}
      title={stateLabel}
    >
      {state === 'allow' ? '✓' : state === 'deny' ? '✕' : '—'}
    </button>
  )
}
