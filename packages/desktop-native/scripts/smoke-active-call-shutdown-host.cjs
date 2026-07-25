const path = require('node:path')
const { app } = require('electron')

async function run() {
  const {
    APP_SHUTDOWN_TIMEOUT_MS,
    disposeWithinDesktopShutdownBudget,
  } = require(path.resolve(
    process.env.SYRNIKE_UTILITY_ROOT,
    'shutdown-budget.cjs',
  ))
  const active = new Set(['voice', 'microphone', 'screen', 'camera'])
  const gracefulSteps = []
  const started = performance.now()
  await Promise.race([
    disposeWithinDesktopShutdownBudget({
      disposeVoice: async () => {
        for (const kind of ['microphone', 'screen', 'camera', 'voice']) {
          if (!active.delete(kind)) {
            throw new Error(`Missing active ${kind} state during shutdown`)
          }
          gracefulSteps.push(`stop:${kind}`)
        }
      },
      disposeRemaining: async () => {
        gracefulSteps.push('dispose:remaining')
      },
      onVoiceDisposeError(error) {
        throw error
      },
      onVoiceDeadlineExceeded(timeoutMs) {
        throw new Error(`Voice disposal exceeded ${timeoutMs}ms`)
      },
      onDeadlineSettled() {
        gracefulSteps.push('deadline:settled')
      },
    }),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error('Active-call shutdown exceeded five seconds')),
        4_999,
      )
    }),
  ])
  if (active.size !== 0) {
    throw new Error(`Active states survived shutdown: ${[...active].join(',')}`)
  }
  const expected = [
    'stop:microphone',
    'stop:screen',
    'stop:camera',
    'stop:voice',
    'dispose:remaining',
    'deadline:settled',
  ]
  if (JSON.stringify(gracefulSteps) !== JSON.stringify(expected)) {
    throw new Error(`Graceful shutdown order drifted: ${gracefulSteps.join(',')}`)
  }
  if (performance.now() - started >= 5_000 ||
      APP_SHUTDOWN_TIMEOUT_MS >= 5_000) {
    throw new Error('Desktop shutdown budget is no longer below five seconds')
  }
  process.stdout.write('active-call-shutdown-budget-ok\n')
}

app.disableHardwareAcceleration()
void app.whenReady().then(run).then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    app.exit(1)
  },
)
