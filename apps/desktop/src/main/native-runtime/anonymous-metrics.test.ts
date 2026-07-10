import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.5.1' } }))

describe('anonymous native metrics reporter', () => {
  it('sends only the fixed anonymous aggregate schema', async () => {
    vi.stubGlobal('__DESKTOP_RELEASE_CHANNEL__', 'nightly')
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }))
    const { AnonymousNativeMetricsReporter } = await import('./anonymous-metrics')
    const reporter = new AnonymousNativeMetricsReporter({
      appVersion: '0.5.1',
      releaseChannel: 'nightly',
      fetch: fetchMock as unknown as typeof fetch,
    })
    reporter.configure({
      enabled: true,
      endpoint: 'https://beta.syrnike13.ru/api/telemetry/native',
    })
    reporter.increment('runtime_lost', 'media')
    reporter.observe('session_start_ms', 123.4, 'media', 'microphone')
    await reporter.flush()

    const request = fetchMock.mock.calls[0]
    expect(request?.[0]).toBe(
      'https://beta.syrnike13.ru/api/telemetry/native',
    )
    const body = JSON.parse(String(request?.[1]?.body))
    expect(body).toEqual({
      version: 1,
      appVersion: '0.5.1',
      releaseChannel: 'nightly',
      metrics: [
        {
          type: 'counter',
          name: 'runtime_lost',
          runtime: 'media',
          sessionKind: 'none',
          value: 1,
        },
        {
          type: 'histogram',
          name: 'session_start_ms',
          runtime: 'media',
          sessionKind: 'microphone',
          valueMs: 123,
          count: 1,
        },
      ],
    })
    expect(request?.[1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })
  })

  it('drops queued data immediately when the user disables metrics', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }))
    const { AnonymousNativeMetricsReporter } = await import('./anonymous-metrics')
    const reporter = new AnonymousNativeMetricsReporter({
      fetch: fetchMock as unknown as typeof fetch,
    })
    reporter.configure({
      enabled: true,
      endpoint: 'https://syrnike13.ru/api/telemetry/native',
    })
    reporter.increment('runtime_ready', 'hooks')
    reporter.configure({ enabled: false, endpoint: '' })
    await reporter.flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses insecure endpoints', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }))
    const { AnonymousNativeMetricsReporter } = await import('./anonymous-metrics')
    const reporter = new AnonymousNativeMetricsReporter({
      fetch: fetchMock as unknown as typeof fetch,
    })
    reporter.configure({
      enabled: true,
      endpoint: 'http://127.0.0.1:14702/telemetry/native',
    })
    reporter.increment('runtime_ready', 'media')
    await reporter.flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('coalesces repeated counters and histogram samples instead of dropping them', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }))
    const { AnonymousNativeMetricsReporter } = await import('./anonymous-metrics')
    const reporter = new AnonymousNativeMetricsReporter({
      appVersion: '0.5.1',
      releaseChannel: 'stable',
      fetch: fetchMock as unknown as typeof fetch,
    })
    reporter.configure({
      enabled: true,
      endpoint: 'https://syrnike13.ru/api/telemetry/native',
    })
    reporter.increment('runtime_lost', 'media')
    reporter.increment('runtime_lost', 'media')
    reporter.observe('runtime_handshake_ms', 110, 'media')
    reporter.observe('runtime_handshake_ms', 200, 'media')
    await reporter.flush()

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.metrics).toEqual([
      expect.objectContaining({ name: 'runtime_lost', value: 2 }),
      expect.objectContaining({
        name: 'runtime_handshake_ms',
        valueMs: 155,
        count: 2,
      }),
    ])
  })
})
