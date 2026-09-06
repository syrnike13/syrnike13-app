import { Schema } from 'effect'

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const GpuContention = Schema.Struct({
  batches: Schema.Int.check(Schema.isGreaterThan(0)),
  allocatedBytes: Schema.Literal(16 * 1024 * 1024),
})
export const decodeGpuContentionEvidence = Schema.decodeUnknownSync(GpuContention)
const Summary = Schema.Struct({
  attempts: Count, switches: Count, pauses: Count,
  delivered: Count, maximumGenerations: Count, liveGenerations: Count,
  dxgiAcquired: Count, dxgiReleased: Count,
  maximumHoldUs: Count, holdBudgetUs: Count,
})
const Sample = Schema.Struct({
  elapsedMs: Count, attempts: Count, switches: Count,
  liveGenerations: Count, retainedFrames: Count,
  handles: Count, threads: Count, dxgiTextures: Count,
  backend: Schema.Literals(['wgc', 'dxgi']),
})
const Observer = Schema.Struct({
  diagnosticOnly: Schema.optionalKey(Schema.Boolean),
  reconnects: Count, tracks: Schema.Struct({ subscribed: Count }),
  video: Schema.Struct({
    p95LatencyMs: Count,
    decodedStreams: Schema.Array(Schema.Struct({
      frames: Count, width: Count, height: Count,
      p95LatencyMs: Schema.NullOr(Count),
      firstFrameAfterStartMs: Schema.NullOr(Count), lastFrameAfterStartMs: Schema.NullOr(Count),
    })),
  }),
})

function maximumGrowth(values: number[]) {
  let minimum = values[0] ?? 0
  let growth = 0
  for (const value of values) {
    growth = Math.max(growth, value - minimum)
    minimum = Math.min(minimum, value)
  }
  return growth
}

export function verifyBackendEvidence(summaryValue: unknown, samplesValue: unknown, observerValue: unknown, mode: string) {
  const summary = Schema.decodeUnknownSync(Summary)(summaryValue)
  const samples = Schema.decodeUnknownSync(Schema.Array(Sample))(samplesValue)
  const observer = Schema.decodeUnknownSync(Observer)(observerValue)
  const failures: string[] = []
  if (observer.diagnosticOnly) failures.push('diagnostic observer cannot establish resource acceptance')
  const switching = mode.includes('switch'), contention = mode.includes('contention')
  if (summary.maximumGenerations > 2 || summary.liveGenerations !== 0 || summary.delivered < 80)
    failures.push('capture generations did not deliver/drain within the hard bound')
  if (summary.dxgiAcquired !== summary.dxgiReleased || summary.holdBudgetUs !== 50_000 || summary.maximumHoldUs > 50_000)
    failures.push('DXGI ownership or duplication hold budget violated')
  if (mode.includes('dxgi') && summary.dxgiAcquired === 0) failures.push('forced DXGI did not acquire frames')
  if (summary.switches !== (switching ? 30 : 0) || summary.attempts !== (switching ? 31 : 1) || summary.pauses !== 0)
    failures.push('unexpected capture recovery or missing forced switch')
  if (observer.reconnects !== 0 || observer.tracks.subscribed !== 3 || observer.video.decodedStreams.length !== 2)
    failures.push('capture changed Room or screen publication (including the single explicit warm-up)')
  const stream = observer.video.decodedStreams.at(-1)
  const duration = stream?.lastFrameAfterStartMs != null && stream.firstFrameAfterStartMs != null
    ? stream.lastFrameAfterStartMs - stream.firstFrameAfterStartMs : 0
  const decodedFps = duration > 0 && stream ? (stream.frames - 1) * 1000 / duration : 0
  if (!stream || stream.frames < 80 || stream.width !== 1920 || stream.height !== 1080)
    failures.push('measured publication did not decode 1080p')
  if (!switching && !contention && decodedFps < 55) failures.push('nominal 1080p60 did not sustain at least 55 decoded fps')
  if (!stream || stream.p95LatencyMs === null || stream.p95LatencyMs > 150)
    failures.push('measured publication p95 frame age exceeded 150 ms')
  if ((observer.video.decodedStreams[0]?.frames ?? 0) < 80)
    failures.push('warmup publication was not decoded before measurement')
  const minimumDuration = switching ? 375_000 : contention ? 60_000 : 120_000
  if (duration < minimumDuration - 5000) failures.push('decoded observation duration incomplete')
  if (!samples.length || (samples.at(-1)?.elapsedMs ?? 0) < minimumDuration - 1000)
    failures.push('capture observation duration incomplete')
  let previous = samples[0]
  for (const sample of samples) {
    if (sample.liveGenerations > 2 || sample.retainedFrames > 6 || sample.dxgiTextures > 13)
      failures.push('capture sample exceeded resource bound')
    if (previous && sample !== previous && (sample.elapsedMs <= previous.elapsedMs || sample.switches < previous.switches || sample.attempts < previous.attempts))
      failures.push('non-monotonic capture evidence')
    previous = sample
  }
  const resourceGrowth: Record<string, { handles: number; threads: number }> = {}
  if (switching) {
    // Compare settled generations of the same backend, after both have warmed.
    const settled = new Map<number, typeof samples[number]>()
    for (const sample of samples) if (sample.switches >= 2 && sample.liveGenerations === 1) settled.set(sample.switches, sample)
    for (const backend of ['wgc', 'dxgi']) {
      const values = [...settled.values()].filter(value => value.backend === backend)
      if (values.length < 10) { failures.push(`insufficient settled ${backend} switch samples`); continue }
      // A shrinking driver/SDK worker pool is not a leak. Compare every later
      // sample with the preceding minimum so growth after a decrease still fails.
      const handles = maximumGrowth(values.map(value => value.handles))
      const threads = maximumGrowth(values.map(value => value.threads))
      resourceGrowth[backend] = { handles, threads }
      if (handles > 16 || threads > 4) failures.push(`${backend} switch resource trend exceeded budget`)
    }
  }
  return { accepted: failures.length === 0, decodedFps, resourceGrowth, failures }
}
