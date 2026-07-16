import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const sentryInit = vi.fn()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.5.1' },
}))
vi.mock('@sentry/electron/main', () => ({
  init: sentryInit,
}))

describe('desktop observability privacy defaults', () => {
  beforeEach(() => {
    sentryInit.mockClear()
    vi.resetModules()
    vi.stubGlobal('__DESKTOP_SENTRY_DSN__', 'https://public@example.invalid/1')
    vi.stubGlobal('__DESKTOP_SENTRY_ENVIRONMENT__', 'test')
    vi.stubGlobal('__DESKTOP_RELEASE_CHANNEL__', 'nightly')
  })

  it('removes native minidumps and screenshots until explicitly enabled', async () => {
    const { initializeDesktopObservability } = await import(
      './desktop-observability'
    )
    initializeDesktopObservability()

    const options = sentryInit.mock.calls[0]?.[0]
    const filtered = options.integrations([
      { name: 'SentryMinidump' },
      { name: 'Screenshots' },
      { name: 'OnUncaughtException' },
    ])

    expect(filtered.map((entry: { name: string }) => entry.name)).toEqual([
      'OnUncaughtException',
    ])
    expect(options.sendDefaultPii).toBe(false)
    expect(options.maxBreadcrumbs).toBe(0)
  })

  it('redacts credentials and endpoint URLs from diagnostic text', async () => {
    const { redactDiagnosticText } = await import('./desktop-observability')
    expect(
      redactDiagnosticText(
        'connect wss://voice.example/room token=abc Bearer xyz',
      ),
    ).toBe('connect [redacted-url] token=[redacted] Bearer [redacted]')
  })

  it('removes local process paths while preserving symbol identifiers', async () => {
    const { initializeDesktopObservability } = await import(
      './desktop-observability'
    )
    initializeDesktopObservability()
    const beforeSend = sentryInit.mock.calls[0]?.[0].beforeSend
    const event = beforeSend({
      exception: {
        values: [
          {
            value: 'native failure',
            stacktrace: {
              frames: [
                {
                  filename: 'C:\\Users\\private\\app.asar\\out\\main\\index.js',
                  abs_path: 'C:\\Users\\private\\app.asar\\out\\main\\index.js',
                },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [
          {
            type: 'pe_dotnet',
            debug_id: 'ABC',
            code_file: 'C:\\Users\\private\\syrnike_media.node',
            debug_file: 'C:\\build\\syrnike_media.pdb',
          },
        ],
      },
    })

    expect(event.exception.values[0].stacktrace.frames[0]).toEqual({
      filename: 'out/main/index.js',
      abs_path: undefined,
    })
    expect(event.debug_meta.images[0]).toMatchObject({
      debug_id: 'ABC',
      code_file: undefined,
      debug_file: undefined,
    })
  })

  it('keeps native minidump handling only after explicit opt-in', async () => {
    const { initializeDesktopObservability } = await import(
      './desktop-observability'
    )
    initializeDesktopObservability({ nativeCrashReportsEnabled: true })
    const options = sentryInit.mock.calls[0]?.[0]
    const filtered = options.integrations([
      { name: 'SentryMinidump' },
      { name: 'OnUncaughtException' },
    ])
    expect(filtered.map((entry: { name: string }) => entry.name)).toEqual([
      'SentryMinidump',
      'OnUncaughtException',
    ])
  })

  it('removes only crash dump files older than seven days', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'syrnike-dumps-'))
    const oldDump = path.join(directory, 'old.dmp')
    const recentDump = path.join(directory, 'recent.dmp')
    const crashpadMetadata = path.join(directory, 'settings.dat')
    const now = Date.now()
    try {
      await writeFile(oldDump, 'old')
      await writeFile(recentDump, 'recent')
      await writeFile(crashpadMetadata, 'keep')
      const oldTime = new Date(now - 8 * 24 * 60 * 60 * 1_000)
      await utimes(oldDump, oldTime, oldTime)
      await utimes(crashpadMetadata, oldTime, oldTime)
      const { pruneExpiredNativeCrashDumps } = await import(
        './desktop-observability'
      )
      await pruneExpiredNativeCrashDumps(directory, now)
      await expect(stat(oldDump)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(recentDump, 'utf8')).resolves.toBe('recent')
      await expect(readFile(crashpadMetadata, 'utf8')).resolves.toBe('keep')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
