import { Effect } from 'effect'

// Initiate forced exit before the 4,900 ms process-observation budget. Electron
// and Windows still need time to finish terminating after app.exit is called.
export const APP_SHUTDOWN_TIMEOUT_MS = 4_000
export const VOICE_SHUTDOWN_GRACE_MS = 2_500

type DesktopShutdownBudgetOptions = {
  disposeVoice(): Promise<void>
  disposeRemaining(): Promise<void>
  onVoiceDisposeError(error: unknown): void
  onVoiceDeadlineExceeded(timeoutMs: number): void
  onDeadlineSettled(): void
  forceExit(): void
  shutdownTimeoutMs?: number
  voiceGraceMs?: number
}

type DesktopShutdownBudgetEffectOptions = Omit<
  DesktopShutdownBudgetOptions,
  'disposeVoice' | 'disposeRemaining'
> & {
  disposeVoice: Effect.Effect<void, unknown>
  disposeRemaining: Effect.Effect<void, unknown>
}

export const disposeWithinDesktopShutdownBudgetEffect = Effect.fn(
  'desktop.disposeWithinShutdownBudget',
)(function*({
  disposeVoice,
  disposeRemaining,
  onVoiceDisposeError,
  onVoiceDeadlineExceeded,
  onDeadlineSettled,
  forceExit,
  shutdownTimeoutMs = APP_SHUTDOWN_TIMEOUT_MS,
  voiceGraceMs = VOICE_SHUTDOWN_GRACE_MS,
}: DesktopShutdownBudgetEffectOptions) {
  // Effect interruption waits for uninterruptible resource finalizers. The
  // process deadline must therefore run independently of that finalization.
  // Keep it armed after disposal completes: app.quit can still be waiting for
  // Electron windows or children. It is unreferenced and dies with the process.
  const processDeadline = setTimeout(forceExit, shutdownTimeoutMs)
  processDeadline.unref?.()
  const disposeVoiceWithinGrace = disposeVoice.pipe(
    Effect.catchIf(
      () => true,
      (error) => Effect.sync(() => onVoiceDisposeError(error)),
    ),
    Effect.raceFirst(
      Effect.sleep(voiceGraceMs).pipe(
        Effect.tap(() =>
          Effect.sync(() => onVoiceDeadlineExceeded(voiceGraceMs)),
        ),
      ),
    ),
  )

  const disposal = disposeVoiceWithinGrace.pipe(
    Effect.flatMap(() => disposeRemaining),
    Effect.timeoutOrElse({
      duration: shutdownTimeoutMs,
      orElse: () => Effect.void,
    }),
    Effect.ensuring(Effect.sync(() => {
      onDeadlineSettled()
    })),
  )

  yield* disposal
})

export function disposeWithinDesktopShutdownBudget({
  disposeVoice,
  disposeRemaining,
  ...options
}: DesktopShutdownBudgetOptions) {
  return Effect.runPromise(
    disposeWithinDesktopShutdownBudgetEffect({
      ...options,
      disposeVoice: Effect.tryPromise({
        try: disposeVoice,
        catch: (cause) => cause,
      }),
      disposeRemaining: Effect.tryPromise({
        try: disposeRemaining,
        catch: (cause) => cause,
      }),
    }),
  )
}
