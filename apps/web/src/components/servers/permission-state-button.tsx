import type { PermissionTriState } from '#/lib/server-permissions'
import { cn } from '#/lib/utils'

export function PermissionStateButton({
  state,
  disabled,
  onChange,
}: {
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

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={cycle}
      className={cn(
        'flex size-8 items-center justify-center rounded-md border text-xs font-semibold transition-colors',
        state === 'allow' &&
          'border-emerald-500/40 bg-emerald-500/15 text-emerald-400',
        state === 'deny' && 'border-red-500/40 bg-red-500/15 text-red-400',
        state === 'neutral' && 'border-border text-muted-foreground',
        disabled && 'cursor-not-allowed opacity-50',
      )}
      title={
        state === 'allow'
          ? 'Разрешено'
          : state === 'deny'
            ? 'Запрещено'
            : 'Наследуется'
      }
    >
      {state === 'allow' ? '✓' : state === 'deny' ? '✗' : '—'}
    </button>
  )
}
