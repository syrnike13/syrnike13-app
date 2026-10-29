import { useEffect, useRef, useState } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { CheckIcon, Undo2Icon } from '#/components/icons'

import { useDraftContext } from '#/components/settings/draft-controller-context'
import { Button } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { cn } from '#/lib/utils'

type ExitKind = 'save' | 'reset'
type BarPhase = 'hidden' | 'shown' | 'saving' | 'ack' | 'exiting'

const SAVE_ACK_MS = 850
const RESET_ACK_MS = 720
const EXIT_MS = 220

type UnsavedChangesBarProps = {
  saveLabel?: string
  saveDisabled?: boolean
  className?: string
  placement?: 'overlay' | 'flow'
  layout?: 'default' | 'compact'
}

export function UnsavedChangesBar({
  saveLabel,
  saveDisabled = false,
  className,
  placement = 'overlay',
  layout = 'default',
}: UnsavedChangesBarProps) {
  const t = useTranslations('settings.unsaved')
  const saveText = saveLabel ?? t('save')
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
        'profile-unsaved-bar pointer-events-none z-20 flex justify-center',
        placement === 'overlay'
          ? 'absolute inset-x-6 bottom-4'
          : 'relative mt-4 w-full',
        className,
      )}
      data-phase={phase}
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          'gradient-surface-solid pointer-events-auto flex w-full max-w-none items-center justify-between gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-popover-foreground shadow-lg',
          layout === 'compact' && 'flex-col items-stretch px-3',
          (showSaveAck || showResetAck) && 'justify-center',
        )}
      >
        {showSaveAck ? (
          <div className="profile-unsaved-feedback flex items-center gap-2 text-sm font-medium">
            <span className="flex size-6 items-center justify-center rounded-full bg-success/15">
              <CheckIcon className="size-4 text-success" />
            </span>
            {t('saved')}
          </div>
        ) : showResetAck ? (
          <div className="profile-unsaved-feedback flex items-center gap-2 text-sm font-medium">
            <span className="flex size-6 items-center justify-center rounded-full bg-accent">
              <Undo2Icon className="size-4 text-accent-foreground" />
            </span>
            {t('reverted')}
          </div>
        ) : (
          <>
            <p className="min-w-0 flex-1 text-sm font-medium leading-snug">
              {t('dirty')}
            </p>
            <div
              className={cn(
                'flex shrink-0 items-center gap-2',
                layout === 'compact' && 'grid grid-cols-2',
              )}
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                className="text-muted-foreground transition-colors hover:text-foreground"
                onClick={handleReset}
              >
                {t('reset')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving || saveDisabled}
                className={cn(
                  'min-w-30 transition-colors',
                  layout === 'compact' && 'min-w-0',
                )}
                onClick={() => void handleSave()}
              >
                {saving ? (
                  <>
                    <Spinner className="size-4" />
                    {t('saving')}
                  </>
                ) : (
                  saveText
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
