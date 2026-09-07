import * as Schema from 'effect/Schema'

/** SFU close placeholders are outside an explicitly finished measurement. */
export function isBitrateTeardownFrame(width: number, height: number, endedAtMs: number,
  nowMs: number, firstAtMs: number, durationMs: number) {
  return width === 2 && height === 2 && firstAtMs > 0 && Number.isSafeInteger(endedAtMs) &&
    endedAtMs >= firstAtMs + durationMs - 5000 && endedAtMs <= nowMs
}

const Sample = Schema.Struct({
  elapsedMs: Schema.Number, profile: Schema.Number, generation: Schema.Number, encoderInstance: Schema.Number,
  width: Schema.Number, height: Schema.Number, fps: Schema.Number, targetBps: Schema.Number, appliedBps: Schema.Number,
  updates: Schema.Number, outcome: Schema.Number, warning: Schema.Boolean, networkBps: Schema.Number,
  captureFrames: Schema.Number, encoderFrames: Schema.Number, encodedBytes: Schema.Number, consumed: Schema.Number,
  videoDepth: Schema.Number, bytes: Schema.Number, handles: Schema.Number, threads: Schema.Number, privateBytes: Schema.Number,
  previewFrames: Schema.Number, previewChanges: Schema.Number, audioPackets: Schema.Number,
  previewStalled: Schema.Boolean, remoteVoicePlayed: Schema.Number,
  gpuActive: Schema.Boolean, gpuBatches: Schema.Number, competingEncoderFrames: Schema.Number, reason: Schema.Number,
})
const Receiver = Schema.Struct({
  frames: Schema.Number, p95AgeMs: Schema.Number, maximumAgeMs: Schema.Number,
  maximumGapMs: Schema.Number, reconnects: Schema.Number, identities: Schema.Array(Schema.String),
  minutes: Schema.Array(Schema.Struct({ frames: Schema.Number, p95AgeMs: Schema.Number })),
  rtcSamples: Schema.Array(Schema.Struct({ atMs: Schema.Number, bytesReceived: Schema.Number, framesDecoded: Schema.Number })),
})

/** Full-interval oracle: a startup/transition failure cannot disappear through slicing. */
export type BitrateScenario = 'network' | 'preview-stall' | 'gpu-pressure' | 'late-static'
export function verifyBitrateEvidence(samplesValue: unknown, receiverValue: unknown, duration: number, startAt: number,
  scenario: BitrateScenario = 'network') {
  const previewStall = scenario === 'preview-stall', gpuPressure = scenario === 'gpu-pressure'
  const lateStatic = scenario === 'late-static'
  const samples = Schema.decodeUnknownSync(Schema.Array(Sample))(samplesValue)
  const receiver = Schema.decodeUnknownSync(Receiver)(receiverValue)
  const failures = new Set<string>(), first = samples[0], last = samples.at(-1)
  if (!first || !last || samples.length < duration / 550 || last.elapsedMs < duration - 1000)
    failures.add('Incomplete publisher interval')
  const commands: number[] = []
  let downs = 0, ups = 0
  for (let index = 0; index < samples.length; ++index) {
    const sample = samples[index]!, previous = samples[index - 1]
    if (sample.previewStalled !== (previewStall && sample.elapsedMs >= 20_000 && sample.elapsedMs < 160_000))
      failures.add('Unexpected preview stall interval')
    if (sample.profile !== 4 || sample.width !== 1920 || sample.height !== 1080 || sample.fps !== 60 ||
        !sample.encoderInstance || sample.generation !== first?.generation || sample.encoderInstance !== first?.encoderInstance)
      failures.add('Preset or encoder/source identity changed')
    if (sample.targetBps < 2_000_000 || sample.targetBps > 8_000_000 || sample.appliedBps < 2_000_000 || sample.appliedBps > 8_000_000)
      failures.add('Bitrate escaped selected preset')
    if (sample.videoDepth > 2 || sample.bytes > 128 * 1024 * 1024) failures.add('Publication queue/memory exceeded')
    if (previous) {
      if (sample.elapsedMs <= previous.elapsedMs || sample.updates < previous.updates ||
          sample.captureFrames < previous.captureFrames || sample.encoderFrames < previous.encoderFrames ||
          sample.previewFrames < previous.previewFrames || sample.audioPackets < previous.audioPackets)
        failures.add('Non-monotonic media progress')
      if (sample.updates > previous.updates) {
        if (sample.updates !== previous.updates + 1) failures.add('Unobserved bitrate commands')
        commands.push(sample.elapsedMs)
      }
      if (sample.appliedBps < previous.appliedBps) ++downs
      if (sample.appliedBps > previous.appliedBps) ++ups
    }
  }
  for (const at of commands) if (commands.filter(value => value > at - 60_000 && value <= at).length > 6)
    failures.add('Bitrate update storm')
  // Progress windows apply to capture, real preview pixels and independent audio,
  // including every network/GPU transition; none is removed as warmup.
  for (let at = 0; at + 10_000 <= duration; at += 10_000) {
    const window = samples.filter(sample => sample.elapsedMs >= at && sample.elapsedMs < at + 10_000)
    const a = window[0], b = window.at(-1)
    const deliberatelyStalled = previewStall && at >= 20_000 && at < 160_000
    const deliberatelyStatic = lateStatic && at >= 30_000 && at < 70_000
    if (!a || !b || b.captureFrames <= a.captureFrames || b.encoderFrames <= a.encoderFrames ||
        (!deliberatelyStalled && !deliberatelyStatic && b.previewChanges <= a.previewChanges) || b.audioPackets <= a.audioPackets)
      failures.add('Capture/encoder/preview/audio stopped in a measured window')
    if (a && b && deliberatelyStalled && (b.previewFrames !== a.previewFrames || b.previewChanges !== a.previewChanges))
      failures.add('Preview consumer did not actually stall')
    if (previewStall && (!a || !b || b.remoteVoicePlayed <= a.remoteVoicePlayed))
      failures.add('Remote voice playback stopped in a measured window')
    if (lateStatic && at >= 40_000 && at < 60_000 && a && b && b.previewChanges !== a.previewChanges)
      failures.add('Static fixture pixels changed')
    if (gpuPressure && at >= 20_000 && at < 140_000 &&
        (!a || !b || b.competingEncoderFrames <= a.competingEncoderFrames || b.gpuBatches <= a.gpuBatches))
      failures.add('Competing hardware encoder/GPU work stopped in a measured window')
  }
  if (previewStall && (duration !== 180_000 || downs < 2 || ups < 2))
    failures.add('Incomplete preview stall/live update scenario')
  if (gpuPressure) {
    const loaded = samples.filter(sample => sample.elapsedMs >= 20_000 && sample.elapsedMs < 140_000)
    if (!loaded.some(sample => sample.gpuActive && sample.gpuBatches > 0 && [3, 4, 5, 6].includes(sample.reason)))
      failures.add('Real GPU workload did not produce local policy pressure')
    if (!loaded.some(sample => sample.appliedBps === 2_000_000 && sample.warning && sample.reason === 10))
      failures.add('GPU pressure did not exercise the minimum warning')
  }
  const mean = (values: typeof samples, field: 'handles' | 'threads' | 'bytes' | 'privateBytes') =>
    values.reduce((sum, sample) => sum + sample[field], 0) / Math.max(1, values.length)
  const growth = Object.fromEntries((['handles', 'threads', 'bytes', 'privateBytes'] as const)
    .map(field => [field, mean(samples.slice(-10), field) - mean(samples.slice(0, 10), field)]))
  if (growth.handles! > 64 || growth.threads! > 16 || growth.bytes! > 8 * 1024 * 1024)
    failures.add('Resources grew beyond existing allowance')
  if (receiver.identities.length !== 2 || new Set(receiver.identities).size !== 2 || receiver.reconnects)
    failures.add('Receiver subscription identity changed')
  if (receiver.p95AgeMs > 150 || receiver.maximumAgeMs > 1500 || receiver.frames < 100)
    failures.add('Full-run receiver freshness failed')
  const minutes = receiver.minutes.filter(minute => minute.frames > 100)
  const meanP95 = (values: typeof minutes) => values.reduce((sum, minute) => sum + minute.p95AgeMs, 0) / Math.max(1, values.length)
  const latencyGrowthMs = meanP95(minutes.slice(-3)) - meanP95(minutes.slice(0, 3))
  if (duration >= 1200_000 && (minutes.length < 20 || latencyGrowthMs > 20)) failures.add('Missing minute evidence or progressive latency')
  if (duration >= 300_000) {
    if (downs < 2 || ups < 2) failures.add('Insufficient repeated live down/up')
    if (!samples.some(sample => sample.gpuActive && sample.gpuBatches > 0)) failures.add('Missing real GPU contention')
    for (let cycle = 0; cycle + 90_000 <= duration; cycle += 300_000) {
      const low = samples.filter(sample => sample.elapsedMs >= cycle + 60_000 && sample.elapsedMs < cycle + 90_000)
      if (!low.some(sample => sample.appliedBps === 2_000_000 && sample.warning)) failures.add('Below-minimum warning/floor not exercised')
      const received = receiver.rtcSamples.filter(sample => sample.atMs >= startAt + cycle + 65_000 && sample.atMs < startAt + cycle + 90_000)
      if (received.length < 2 || received.at(-1)!.framesDecoded <= received[0]!.framesDecoded || received.at(-1)!.bytesReceived <= received[0]!.bytesReceived)
        failures.add('No decoded output below minimum')
    }
  }
  return { accepted: failures.size === 0, failures: [...failures], downs, ups, commands, growth, latencyGrowthMs }
}
