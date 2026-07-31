export const APP_SHUTDOWN_TIMEOUT_MS = 4_900
export const VOICE_SHUTDOWN_GRACE_MS = 2_500

type DesktopShutdownBudgetOptions = {
  disposeVoice(): Promise<void>
  disposeRemaining(): Promise<void>
  onVoiceDisposeError(error: unknown): void
  onVoiceDeadlineExceeded(timeoutMs: number): void
  onDeadlineSettled(): void
  shutdownTimeoutMs?: number
  voiceGraceMs?: number
}

export async function disposeWithinDesktopShutdownBudget({
  disposeVoice,
  disposeRemaining,
  onVoiceDisposeError,
  onVoiceDeadlineExceeded,
  onDeadlineSettled,
  shutdownTimeoutMs = APP_SHUTDOWN_TIMEOUT_MS,
  voiceGraceMs = VOICE_SHUTDOWN_GRACE_MS,
}: DesktopShutdownBudgetOptions) {
  let shutdownTimeout: ReturnType<typeof setTimeout> | null = null
  let voiceTimeout: ReturnType<typeof setTimeout> | null = null

  const disposal = Promise.race([
    Promise.resolve().then(disposeVoice).catch(onVoiceDisposeError),
    new Promise<void>((resolve) => {
      voiceTimeout = setTimeout(() => {
        voiceTimeout = null
        onVoiceDeadlineExceeded(voiceGraceMs)
        resolve()
      }, voiceGraceMs)
    }),
  ]).then(async () => {
    if (voiceTimeout) {
      clearTimeout(voiceTimeout)
      voiceTimeout = null
    }
    await disposeRemaining()
  })

  try {
    await Promise.race([
      disposal,
      new Promise<void>((resolve) => {
        shutdownTimeout = setTimeout(resolve, shutdownTimeoutMs)
      }),
    ])
  } finally {
    if (shutdownTimeout) clearTimeout(shutdownTimeout)
    if (voiceTimeout) clearTimeout(voiceTimeout)
    onDeadlineSettled()
  }
}
