import { app, crashReporter } from 'electron'
import * as Sentry from '@sentry/electron/main'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Effect } from 'effect'

export const NATIVE_CRASH_DUMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

export type DesktopObservabilityOptions = {
  /** Native minidumps can contain memory and are disabled until the user opts in. */
  nativeCrashReportsEnabled?: boolean
}

export type DesktopObservabilityState = {
  enabled: boolean
  nativeCrashReportsEnabled: boolean
}

let initialized = false
let initializedNativeCrashReportsEnabled = false

export function initializeDesktopObservability(
  options: DesktopObservabilityOptions = {},
): DesktopObservabilityState {
  const nativeCrashReportsEnabled =
    options.nativeCrashReportsEnabled === true

  if (initialized || !__DESKTOP_SENTRY_DSN__) {
    if (
      !initialized &&
      nativeCrashReportsEnabled &&
      !__DESKTOP_SENTRY_DSN__
    ) {
      try {
        crashReporter.start({
          uploadToServer: false,
          globalExtra: {
            release_channel: __DESKTOP_RELEASE_CHANNEL__,
            build_commit: __DESKTOP_COMMIT_SHA__,
            native_crash_consent: 'enabled',
          },
        })
        initialized = true
        initializedNativeCrashReportsEnabled = true
      } catch {
        // Crash reporting is diagnostic-only and must never block app startup.
      }
    }
    return {
      enabled: initialized,
      nativeCrashReportsEnabled: initializedNativeCrashReportsEnabled,
    }
  }

  initialized = true
  initializedNativeCrashReportsEnabled = nativeCrashReportsEnabled
  Sentry.init({
    dsn: __DESKTOP_SENTRY_DSN__,
    environment: __DESKTOP_SENTRY_ENVIRONMENT__,
    release: `syrnike13-desktop@${app.getVersion()}`,
    sendDefaultPii: false,
    attachScreenshot: false,
    maxBreadcrumbs: 0,
    tracesSampleRate: 0,
    beforeBreadcrumb: () => null,
    integrations(defaultIntegrations) {
      return defaultIntegrations.filter((integration) => {
        if (integration.name.toLowerCase().includes('screenshot')) return false
        if (
          !nativeCrashReportsEnabled &&
          integration.name.toLowerCase().includes('minidump')
        ) {
          return false
        }
        return true
      })
    },
    initialScope: {
      tags: {
        release_channel: __DESKTOP_RELEASE_CHANNEL__,
        process_type: 'browser',
      },
    },
    beforeSend: sanitizeDesktopErrorEvent,
  })

  return { enabled: true, nativeCrashReportsEnabled }
}

export function pruneExpiredNativeCrashDumps(
  directory = app.getPath('crashDumps'),
  now = Date.now(),
) {
  return Effect.runPromise(pruneExpiredNativeCrashDumpsEffect(directory, now))
}

const pruneDirectory: (
  directory: string,
  now: number,
) => Effect.Effect<void, unknown> = Effect.fn('desktop.pruneNativeCrashDirectory')(
  function*(directory: string, now: number) {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) => cause,
    })
    yield* Effect.all(
      entries.map((entry) =>
        Effect.gen(function*() {
          const entryPath = path.join(directory, entry.name)
          if (entry.isDirectory()) {
            yield* pruneDirectory(entryPath, now)
            return
          }
          if (!entry.isFile()) return
          // Crashpad keeps database metadata beside reports. Removing arbitrary old
          // files can corrupt the database; the privacy retention applies only to
          // the minidump payload itself.
          if (path.extname(entry.name).toLowerCase() !== '.dmp') return
          const metadata = yield* Effect.tryPromise({
            try: () => stat(entryPath),
            catch: (cause) => cause,
          })
          if (now - metadata.mtimeMs > NATIVE_CRASH_DUMP_RETENTION_MS) {
            yield* Effect.tryPromise({
              try: () => rm(entryPath, { force: true }),
              catch: (cause) => cause,
            })
          }
        }),
      ),
      { concurrency: 'unbounded' },
    )
  },
)

export const pruneExpiredNativeCrashDumpsEffect = Effect.fn(
  'desktop.pruneExpiredNativeCrashDumps',
)(function*(directory = app.getPath('crashDumps'), now = Date.now()) {
  yield* pruneDirectory(directory, now).pipe(
    Effect.catch((error) =>
      isErrnoCode(error, 'ENOENT') ? Effect.void : Effect.fail(error)
    ),
  )
})

function isErrnoCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

const sanitizeDesktopErrorEvent: NonNullable<
  Parameters<typeof Sentry.init>[0]['beforeSend']
> = (event) => {
  const allowedTags = new Set([
    'release_channel',
    'process_type',
    'native_runtime',
    'runtime_state',
    'failure_code',
    'failure_stage',
    'build_commit',
    'native_crash_consent',
    'native_runtime_kind',
    'native_runtime_run',
    'native_runtime_commit',
    'native_host_stage',
    'native_last_command',
    'native_camera_stage',
  ])
  const crashAttributionTags = Object.fromEntries(
    Object.entries(event.extra ?? {}).flatMap(([key, value]) =>
      allowedTags.has(key) && typeof value === 'string'
        ? [[key, redactDiagnosticText(value).slice(0, 127)]]
        : [],
    ),
  )
  event.user = undefined
  event.request = undefined
  event.breadcrumbs = undefined
  event.contexts = undefined
  event.extra = undefined
  event.server_name = undefined
  event.transaction = undefined
  event.fingerprint = undefined

  if (event.message) event.message = redactDiagnosticText(event.message)
  if (event.logentry?.message) {
    event.logentry.message = redactDiagnosticText(event.logentry.message)
  }
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = redactDiagnosticText(value.value)
    sanitizeStackFrames(value.stacktrace?.frames)
  }
  for (const thread of event.threads?.values ?? []) {
    sanitizeStackFrames(thread.stacktrace?.frames)
  }
  for (const image of event.debug_meta?.images ?? []) {
    if ('code_file' in image) image.code_file = undefined
    if ('debug_file' in image) image.debug_file = undefined
  }

  event.tags = {
    ...Object.fromEntries(
      Object.entries(event.tags ?? {}).filter(([key]) => allowedTags.has(key)),
    ),
    ...crashAttributionTags,
  }

  return event
}

function sanitizeStackFrames(
  frames: Array<{ filename?: string; abs_path?: string }> | undefined,
) {
  for (const frame of frames ?? []) {
    frame.abs_path = undefined
    if (frame.filename) frame.filename = safeSourceFilename(frame.filename)
  }
}

function safeSourceFilename(value: string) {
  const normalized = value.replaceAll('\\', '/')
  const appArchive = normalized.lastIndexOf('/app.asar/')
  if (appArchive >= 0) return normalized.slice(appArchive + '/app.asar/'.length)
  return normalized.split('/').at(-1) ?? '[redacted-path]'
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(
      /\b(token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]',
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .slice(0, 2_048)
}
