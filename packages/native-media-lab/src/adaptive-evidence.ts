import { Schema } from 'effect'

const Sample = Schema.Struct({
  elapsedMs: Schema.Number, profile: Schema.Number, generation: Schema.Number,
  desiredRevision: Schema.Number, appliedRevision: Schema.Number,
  videoDepth: Schema.Number, bytes: Schema.Number, handles: Schema.Number,
  threads: Schema.Number, consumed: Schema.Number, keyframeRequests: Schema.Number,
  contentionBatches: Schema.Number, contentionActive: Schema.Boolean,
})
const Samples = Schema.Array(Sample)
const Observer = Schema.Struct({ video: Schema.Struct({
  latencyMinutes: Schema.Array(Schema.Struct({ minute: Schema.Number, frames: Schema.Number, p95Ms: Schema.Number })),
  decodedStreams: Schema.Array(Schema.Struct({
    frames: Schema.Number, width: Schema.Number, height: Schema.Number,
    subscribedAfterStartMs: Schema.Number,
    firstFrameAfterStartMs: Schema.NullOr(Schema.Number),
  })),
}) })

/** Reject local-success reports unless each replacement also decodes remotely. */
export function verifyAdaptiveEvidence(samplesValue: unknown, observerValue: unknown, contention: boolean) {
  const samples = Schema.decodeUnknownSync(Samples)(samplesValue)
  const observer = Schema.decodeUnknownSync(Observer)(observerValue)
  const failures: string[] = []
  const duration = contention ? 1_200_000 : 120_000
  if (samples.length < duration / 1000 || (samples.at(-1)?.elapsedMs ?? 0) < duration - 1000)
    failures.push('insufficient adaptive observation duration')
  const changes: number[] = []
  let previous = samples[0]
  for (const sample of samples) {
    if (sample.profile < 0 || sample.profile > 4 || sample.videoDepth > 2 || sample.bytes > 128 * 1024 * 1024)
      failures.push('publication profile/queue/memory budget exceeded')
    if (!contention && sample.appliedRevision === 2 && sample.profile !== 0)
      failures.push('applied low user ceiling exceeded')
    if (previous && sample !== previous) {
      if (sample.elapsedMs <= previous.elapsedMs || sample.generation < previous.generation || sample.consumed < previous.consumed)
        failures.push('non-monotonic adaptive progress')
      if (sample.generation !== previous.generation) changes.push(sample.elapsedMs)
    }
    previous = sample
  }
  const maximumChangesPerMinute = Math.max(0, ...changes.map(time => changes.filter(value => value > time - 60_000 && value <= time).length))
  if (maximumChangesPerMinute > 6) failures.push('profile change rate exceeded')
  if (!contention && (samples.at(-1)?.profile !== 4 || samples.at(-1)?.appliedRevision !== 3))
    failures.push('quality did not recover to restored user ceiling')
  if (contention && (!samples.some(s => s.contentionActive) || !samples.some(s => !s.contentionActive) || (samples.at(-1)?.contentionBatches ?? 0) < 20))
    failures.push('alternating GPU contention was not observed')
  const decoded = observer.video.decodedStreams.filter(stream => stream.frames > 0)
  if (decoded.length < changes.length + 1) failures.push('a replacement did not decode remotely')
  if (decoded.some(stream => stream.firstFrameAfterStartMs === null || stream.firstFrameAfterStartMs - stream.subscribedAfterStartMs > 10_000))
    failures.push('replacement first-frame deadline exceeded')
  // Compare equal-profile allocations: increasing resolution is not a leak.
  const growth = [0, 1, 2, 3, 4].flatMap(profile => {
    const same = samples.filter(sample => sample.profile === profile)
    if (same.length < 20) return []
    const mean = (values: typeof same, field: 'handles' | 'threads' | 'bytes') => values.reduce((sum, s) => sum + s[field], 0) / values.length
    const first = same.slice(0, 10), last = same.slice(-10)
    return [{ profile, handles: mean(last, 'handles') - mean(first, 'handles'),
      threads: mean(last, 'threads') - mean(first, 'threads'), bytes: mean(last, 'bytes') - mean(first, 'bytes') }]
  })
  if (growth.some(value => value.handles > 64 || value.threads > 16 || value.bytes > 8 * 1024 * 1024))
    failures.push('equal-profile resources grew beyond bounded allowance')
  const minutes = observer.video.latencyMinutes.filter(minute => minute.frames > 100)
  const meanP95 = (values: typeof minutes) => values.reduce((sum, value) => sum + value.p95Ms, 0) / Math.max(1, values.length)
  const latencyGrowthMs = meanP95(minutes.slice(-3)) - meanP95(minutes.slice(0, 3))
  if (contention && (minutes.length < 20 || latencyGrowthMs > 20)) failures.push('latency grew during contention or minute evidence is missing')
  return { accepted: failures.length === 0, failures: [...new Set(failures)], maximumChangesPerMinute, growth, latencyGrowthMs, decodedPublications: decoded.length }
}
