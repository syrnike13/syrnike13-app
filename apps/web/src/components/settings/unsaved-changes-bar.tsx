import { useEffect, useRef, useState } from 'react'
import { CheckIcon, Loader2Icon, Undo2Icon } from '#/components/icons'

import { useDraftContext } from '#/components/settings/draft-controller-context'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'

type ExitKind = 'save' | 'reset'
type BarPhase = 'hidden' | 'shown' | 'saving' | 'ack' | 'exiting'

const SAVE_ACK_MS = 850
const RESET_ACK_MS = 720
const EXIT_MS = 220

type UnsavedChangesBarProps = {
  saveLabel?: string
  className?: string
}

export function UnsavedChangesBar({
  saveLabel = 'Сохранить',
  className,
}: UnsavedChangesBarProps) {
  const ctx = useDraftContext()
  const controller = ctx?.controller

  const isDirty = controller?.isDirty ?? false

  const [phase, setPhase] = useState<BarPhase>('hidden')
  const [exitKind, setExitKind] = useState<ExitKind | null>(null)
  const timersRef = useRef<number[]>([])

  const clearTimers = () => {
    for (const id of timersRef.current) {
      window.clearTimeout(id)
    }
    timersRef.current = []
  }

  const schedule = (fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms)
    timersRef.current.push(id)
  }

  useEffect(() => {
    if (isDirty && phase === 'hidden') {
      setPhase('shown')
      setExitKind(null)
      return
    }

    if (isDirty && phase === 'exiting') {
      clearTimers()
      setPhase('shown')
      setExitKind(null)
      return
    }

    if (!isDirty && phase === 'shown') {
      clearTimers()
      setPhase('exiting')
      setExitKind(null)
      schedule(() => setPhase('hidden'), EXIT_MS)
    }
  }, [isDirty, phase])

  useEffect(() => () => clearTimers(), [])

  if (phase === 'hidden') return null

  function dismissAfterAck(kind: ExitKind) {
    clearTimers()
    setExitKind(kind)
    setPhase('ack')
    const ackMs = kind === 'save' ? SAVE_ACK_MS : RESET_ACK_MS
    schedule(() => setPhase('exiting'), ackMs)
    schedule(() => {
      setPhase('hidden')
      setExitKind(null)
    }, ackMs + EXIT_MS)
  }

  async function handleSave() {
    if (!controller || phase !== 'shown') return
    setPhase('saving')
    clearTimers()
    const ok = await controller.save()
    if (!ok) {
      setPhase('shown')
      return
    }
    dismissAfterAck('save')
  }

  function handleReset() {
    if (!controller || phase !== 'shown') return
    clearTimers()
    const reverted = controller.reset()
    if (!reverted) {
      setPhase('hidden')
      setExitKind(null)
      return
    }
    dismissAfterAck('reset')
  }

  const saving = phase === 'saving'
  const showingFeedback = phase === 'ack' || phase === 'exiting'
  const showSaveAck = showingFeedback && exitKind === 'save'
  const showResetAck = showingFeedback && exitKind === 'reset'
  return (
    <div
      className={cn(
        'profile-unsaved-bar pointer-events-none absolute inset-x-6 bottom-4 z-20 flex justify-center',
        className,
      )}
      data-phase={phase}
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          'gradient-surface-solid pointer-events-auto flex w-full max-w-none items-center justify-between gap-3 rounded-lg border border-border/80 bg-popover px-4 py-3 text-popover-foreground shadow-lg',
          (showSaveAck || showResetAck) && 'justify-center',
        )}
      >
        {showSaveAck ? (
          <div className="profile-unsaved-feedback flex items-center gap-2 text-sm font-medium">
            <span className="flex size-6 items-center justify-center rounded-full bg-chart-3/15">
              <CheckIcon className="size-4 text-chart-3" />
            </span>
            Изменения сохранены
          </div>
        ) : showResetAck ? (
          <div className="profile-unsaved-feedback flex items-center gap-2 text-sm font-medium">
            <span className="flex size-6 items-center justify-center rounded-full bg-accent">
              <Undo2Icon className="size-4 text-accent-foreground" />
            </span>
            Изменения отменены
          </div>
        ) : (
          <>
            <p className="min-w-0 flex-1 text-sm font-medium leading-snug">
              Есть несохранённые изменения
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                className="text-muted-foreground transition-colors hover:text-foreground"
                onClick={handleReset}
              >
                Сбросить
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving}
                className="min-w-[7.5rem] transition-colors"
                onClick={() => void handleSave()}
              >
                {saving ? (
                  <>
                    <Loader2Icon className="size-4 animate-spin" />
                    Сохранение…
                  </>
                ) : (
                  saveLabel
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
