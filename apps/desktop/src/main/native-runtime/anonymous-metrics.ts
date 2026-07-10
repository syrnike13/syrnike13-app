import { app } from 'electron'

import type { NativeMediaController } from './native-media-controller'
import type {
  NativeRuntimeSupervisor,
  NativeRuntimeSupervisorSnapshot,
} from './runtime-supervisor'

const MAX_BATCH_SIZE = 100
const HISTOGRAM_COALESCE_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 60_000,
] as const
const FLUSH_INTERVAL_MS = 30_000
const RETRY_INTERVAL_MS = 60_000
const MAX_DURATION_MS = 60_000
const MAX_COALESCED_SAMPLES = 1_000
const MAX_BATCH_SAMPLES = 1_000

export type NativeMetricRuntime = 'media' | 'hooks'
export type NativeMetricSessionKind = 'none' | 'microphone' | 'screen'
export type NativeMetricCounterName =
  | 'runtime_started'
  | 'runtime_ready'
  | 'runtime_lost'
  | 'runtime_degraded'
  | 'session_start_succeeded'
  | 'session_start_failed'
  | 'session_start_cancelled'
export type NativeMetricHistogramName =
  | 'runtime_handshake_ms'
  | 'session_start_ms'

export type AnonymousNativeMetric =
  | {
      type: 'counter'
      name: NativeMetricCounterName
      runtime: NativeMetricRuntime
      sessionKind: NativeMetricSessionKind
      value: number
    }
  | {
      type: 'histogram'
      name: NativeMetricHistogramName
      runtime: NativeMetricRuntime
      sessionKind: NativeMetricSessionKind
      valueMs: number
      count: number
    }

export type AnonymousNativeMetricBatch = {
  version: 1
  appVersion: string
  releaseChannel: 'stable' | 'nightly'
  metrics: AnonymousNativeMetric[]
}

type ReporterOptions = {
  appVersion?: string
  releaseChannel?: 'stable' | 'nightly'
  fetch?: typeof fetch
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
}

export class AnonymousNativeMetricsReporter {
  private enabled = false
  private endpoint = ''
  private readonly queue: AnonymousNativeMetric[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing = false

  constructor(private readonly options: ReporterOptions = {}) {}

  configure(options: { enabled: boolean; endpoint: string }) {
    this.enabled = options.enabled && isSecureMetricsEndpoint(options.endpoint)
    this.endpoint = this.enabled ? options.endpoint : ''
    if (!this.enabled) {
      this.queue.length = 0
      this.clearTimer()
      return
    }
    if (this.queue.length > 0) this.scheduleFlush(FLUSH_INTERVAL_MS)
  }

  increment(
    name: NativeMetricCounterName,
    runtime: NativeMetricRuntime,
    sessionKind: NativeMetricSessionKind = 'none',
  ) {
    this.enqueue({ type: 'counter', name, runtime, sessionKind, value: 1 })
  }

  observe(
    name: NativeMetricHistogramName,
    valueMs: number,
    runtime: NativeMetricRuntime,
    sessionKind: NativeMetricSessionKind = 'none',
  ) {
    if (!Number.isFinite(valueMs)) return
    this.enqueue({
      type: 'histogram',
      name,
      runtime,
      sessionKind,
      valueMs: Math.min(MAX_DURATION_MS, Math.max(0, Math.round(valueMs))),
      count: 1,
    })
  }

  async flush() {
    if (!this.enabled || !this.endpoint || this.flushing || this.queue.length === 0) {
      return
    }
    this.flushing = true
    this.clearTimer()
    const metrics = this.takeBatch()
    const batch: AnonymousNativeMetricBatch = {
      version: 1,
      appVersion: this.options.appVersion ?? app.getVersion(),
      releaseChannel:
        this.options.releaseChannel ??
        (__DESKTOP_RELEASE_CHANNEL__ === 'nightly' ? 'nightly' : 'stable'),
      metrics,
    }
    try {
      const response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) throw new Error(`Native metrics rejected (${response.status})`)
    } catch {
      if (this.enabled) {
        for (const metric of metrics) this.mergeMetric(metric)
      }
    } finally {
      this.flushing = false
      if (this.queue.length > 0) {
        this.scheduleFlush(
          this.queue.length >= MAX_BATCH_SIZE
            ? FLUSH_INTERVAL_MS
            : RETRY_INTERVAL_MS,
        )
      }
    }
  }

  dispose() {
    this.enabled = false
    this.endpoint = ''
    this.queue.length = 0
    this.clearTimer()
  }

  private enqueue(metric: AnonymousNativeMetric) {
    if (!this.enabled) return
    this.mergeMetric(metric)
    this.scheduleFlush(
      this.queue.length >= MAX_BATCH_SIZE ? 0 : FLUSH_INTERVAL_MS,
    )
  }

  private takeBatch() {
    const batch: AnonymousNativeMetric[] = []
    let samples = 0
    while (batch.length < MAX_BATCH_SIZE && this.queue.length > 0) {
      const metric = this.queue[0]
      if (!metric) break
      const metricSamples = metric.type === 'counter' ? metric.value : metric.count
      const available = MAX_BATCH_SAMPLES - samples
      if (available <= 0) break
      if (metricSamples <= available) {
        batch.push(metric)
        this.queue.shift()
        samples += metricSamples
        continue
      }
      if (metric.type === 'counter') {
        batch.push({ ...metric, value: available })
        metric.value -= available
      } else {
        batch.push({ ...metric, count: available })
        metric.count -= available
      }
      break
    }
    return batch
  }

  private mergeMetric(metric: AnonymousNativeMetric) {
    const coalescedValue =
      metric.type === 'histogram'
        ? (HISTOGRAM_COALESCE_BUCKETS_MS.find(
            (limit) => metric.valueMs <= limit,
          ) ?? MAX_DURATION_MS)
        : undefined
    const existing = this.queue.find((entry) => {
      if (
        entry.type !== metric.type ||
        entry.name !== metric.name ||
        entry.runtime !== metric.runtime ||
        entry.sessionKind !== metric.sessionKind
      ) {
        return false
      }
      if (entry.type === 'counter' && metric.type === 'counter') {
        return entry.value + metric.value <= MAX_COALESCED_SAMPLES
      }
      if (entry.type !== 'histogram' || metric.type !== 'histogram') {
        return false
      }
      const entryBucket =
        HISTOGRAM_COALESCE_BUCKETS_MS.find(
          (limit) => entry.valueMs <= limit,
        ) ?? MAX_DURATION_MS
      return (
        entryBucket === coalescedValue &&
        entry.count + metric.count <= MAX_COALESCED_SAMPLES
      )
    })
    if (!existing) {
      this.queue.push(metric)
      return
    }
    if (existing.type === 'counter' && metric.type === 'counter') {
      if (existing.value + metric.value > MAX_COALESCED_SAMPLES) {
        this.queue.push(metric)
        return
      }
      existing.value += metric.value
      return
    }
    if (existing.type === 'histogram' && metric.type === 'histogram') {
      const count = existing.count + metric.count
      if (count > MAX_COALESCED_SAMPLES) {
        this.queue.push(metric)
        return
      }
      existing.valueMs = Math.round(
        (existing.valueMs * existing.count + metric.valueMs * metric.count) /
          count,
      )
      existing.count = count
    }
  }

  private scheduleFlush(delayMs: number) {
    if (this.timer) return
    const schedule = this.options.schedule ?? setTimeout
    this.timer = schedule(() => {
      this.timer = null
      void this.flush()
    }, delayMs)
    this.timer.unref?.()
  }

  private clearTimer() {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

export const anonymousNativeMetricsReporter =
  new AnonymousNativeMetricsReporter()

export function attachNativeRuntimeMetrics(
  supervisor: NativeRuntimeSupervisor,
  runtime: NativeMetricRuntime,
  reporter: AnonymousNativeMetricsReporter = anonymousNativeMetricsReporter,
) {
  let previous: NativeRuntimeSupervisorSnapshot['status'] = 'stopped'
  let handshakeStartedAt = 0
  return supervisor.onStateChange((snapshot) => {
    if (snapshot.status === previous) return
    const now = performance.now()
    if (snapshot.status === 'starting') {
      handshakeStartedAt = now
      reporter.increment('runtime_started', runtime)
    } else if (snapshot.status === 'ready') {
      reporter.increment('runtime_ready', runtime)
      if (handshakeStartedAt > 0) {
        reporter.observe(
          'runtime_handshake_ms',
          now - handshakeStartedAt,
          runtime,
        )
      }
    } else if (snapshot.status === 'recovering') {
      handshakeStartedAt = now
      reporter.increment('runtime_lost', runtime)
    } else if (snapshot.status === 'degraded') {
      reporter.increment('runtime_degraded', runtime)
    }
    previous = snapshot.status
  })
}

export function attachNativeMediaSessionMetrics(
  controller: NativeMediaController,
  reporter: AnonymousNativeMetricsReporter = anonymousNativeMetricsReporter,
) {
  return controller.subscribe((event) => {
    if (event.type !== 'operationMetric' || event.operation !== 'sessionStart') {
      return
    }
    reporter.increment(
      event.outcome === 'succeeded'
        ? 'session_start_succeeded'
        : event.outcome === 'cancelled'
          ? 'session_start_cancelled'
          : 'session_start_failed',
      'media',
      event.kind,
    )
    reporter.observe(
      'session_start_ms',
      event.durationMs,
      'media',
      event.kind,
    )
  })
}

function isSecureMetricsEndpoint(value: string) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
