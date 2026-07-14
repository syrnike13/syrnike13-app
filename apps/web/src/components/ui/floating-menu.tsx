import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '#/lib/utils'

type FloatingMenuProps = {
  open: boolean
  x: number
  y: number
  onClose: () => void
  children: ReactNode
  className?: string
}

export function FloatingMenu({
  open,
  x,
  y,
  onClose,
  children,
  className,
}: FloatingMenuProps) {
  useEffect(() => {
    if (!open) return

    function handleDismiss() {
      onClose()
    }

    window.addEventListener('pointerdown', handleDismiss)
    window.addEventListener('scroll', handleDismiss, true)
    window.addEventListener('resize', handleDismiss)

    return () => {
      window.removeEventListener('pointerdown', handleDismiss)
      window.removeEventListener('scroll', handleDismiss, true)
      window.removeEventListener('resize', handleDismiss)
    }
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className={cn(
        'gradient-surface-floating z-[100] min-w-[11rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
        className,
      )}
      style={{ position: 'fixed', left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  )
}

export function FloatingMenuItem({
  children,
  onClick,
  destructive,
  disabled,
}: {
  children: ReactNode
  onClick?: () => void
  destructive?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent',
        destructive && 'text-destructive hover:text-destructive',
        disabled && 'pointer-events-none opacity-50',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
