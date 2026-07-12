import { useEffect, useRef, useState } from 'react'
import { CheckIcon, Loader2Icon, Undo2Icon } from '#/components/icons'

import { useDraftContext } from '#/components/settings/draft-controller-context'
import { cn } from '#/lib/utils'

type ExitKind = 'save' | 'reset'
type BarPhase = 'hidden' | 'shown' | 'saving' | 'ack' | 'exiting'

const SAVE_ACK_MS = 700
const RESET_ACK_MS = 520
const SAVE_EXIT_MS = 380
const RESET_EXIT_MS = 320

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

    if (!isDirty && phase === 'shown') {
      clearTimers()
      setPhase('hidden')
      setExitKind(null)
    }
  }, [isDirty, phase])

  useEffect(() => () => clearTimers(), [])

  if (phase === 'hidden') return null

  function dismissAfterAck(kind: ExitKind) {
    clearTimers()
    setExitKind(kind)
    setPhase('ack')
    const ackMs = kind === 'save' ? SAVE_ACK_MS : RESET_ACK_MS
    const exitMs = kind === 'save' ? SAVE_EXIT_MS : RESET_EXIT_MS
    schedule(() => setPhase('exiting'), ackMs)
    schedule(() => {
      setPhase('hidden')
      setExitKind(null)
    }, ackMs + exitMs)
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
  const showSaveAck = phase === 'ack' && exitKind === 'save'
  const showResetAck = phase === 'ack' && exitKind === 'reset'
  const exiting = phase === 'exiting'

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-6 bottom-4 z-20 flex justify-center',
        phase === 'shown' || phase === 'saving'
          ? 'profile-unsaved-bar-enter'
          : exiting && exitKind === 'reset'
            ? 'profile-unsaved-bar-exit-reset'
            : exiting
              ? 'profile-unsaved-bar-exit-save'
              : showResetAck
                ? 'profile-unsaved-bar-ack-reset'
                : null,
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          'pointer-events-auto flex w-full max-w-none items-center justify-between gap-3 rounded-lg border border-white/8 bg-muted px-4 py-3 text-foreground shadow-md',
          (showSaveAck || showResetAck) && 'justify-center',
          showResetAck && 'profile-unsaved-reset-panel',
        )}
      >
        {showSaveAck ? (
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="profile-unsaved-check flex size-6 items-center justify-center rounded-full bg-chart-3/20">
              <CheckIcon className="size-4 text-chart-3" />
            </span>
            Изменения сохранены
          </div>
        ) : showResetAck ? (
          <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
            <span className="profile-unsaved-undo flex size-6 items-center justify-center rounded-full bg-primary/15">
              <Undo2Icon className="size-4 text-primary" />
            </span>
            Изменения отменены
          </div>
        ) : (
          <>
            <p className="min-w-0 flex-1 text-sm leading-snug text-foreground/90">
              Есть несохранённые изменения
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={saving}
                className="profile-unsaved-reset-btn rounded px-2 py-1 text-sm font-medium text-primary transition-opacity hover:underline disabled:opacity-50"
                onClick={handleReset}
              >
                Сбросить
              </button>
              <button
                type="button"
                disabled={saving}
                className="inline-flex min-w-[7.5rem] items-center justify-center gap-1.5 rounded bg-chart-3 px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-chart-3/90 disabled:opacity-70"
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
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
