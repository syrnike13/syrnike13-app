export interface SyncPulse { atMs: number; code: number }

/** Frequency is encoded by the fixture, independently of transport timestamps. */
export function pulseCode(samples: Int16Array, rate = 48_000): { code: number; rms: number } {
  let squares = 0
  for (const value of samples) squares += value * value
  let code = 0, maximum = 0
  for (let index = 0; index < 16; ++index) {
    const coefficient = 2 * Math.cos(2 * Math.PI * (600 + index * 100) / rate)
    let a = 0, b = 0
    for (const value of samples) { const next = value + coefficient * a - b; b = a; a = next }
    const energy = a * a + b * b - coefficient * a * b
    if (energy > maximum) { maximum = energy; code = index }
  }
  return { code, rms: Math.sqrt(squares / Math.max(1, samples.length)) }
}

function matchPulses(video: readonly SyncPulse[], audio: readonly SyncPulse[]) {
  const pairs: { atMs: number; skewMs: number; code: number }[] = []
  const used = new Set<number>()
  for (const visual of video) {
    let selected = -1, distance = 500
    for (let index = 0; index < audio.length; ++index) {
      const sound = audio[index]!
      const delta = Math.abs(sound.atMs - visual.atMs)
      if (!used.has(index) && sound.code === visual.code && delta < distance) { selected = index; distance = delta }
    }
    if (selected >= 0) {
      used.add(selected)
      pairs.push({ atMs: visual.atMs, skewMs: audio[selected]!.atMs - visual.atMs, code: visual.code })
    }
  }
  return pairs
}

export function verifyAudioCaptureAge(capture: readonly SyncPulse[], received: readonly SyncPulse[]) {
  const pairs = matchPulses(capture, received)
  const ages = pairs.map(pair => pair.skewMs).sort((a, b) => a - b)
  const p95Ms = ages[Math.max(0, Math.ceil(ages.length * 0.95) - 1)] ?? 0
  const accepted = pairs.length >= 3 && pairs.length >= received.length * 0.9 &&
    (ages[0] ?? -1) >= 0 && p95Ms <= 150
  return { accepted, matchedPulses: pairs.length, p95Ms, minimumMs: ages[0] ?? null, maximumMs: ages.at(-1) ?? null }
}

export function verifyAudioSync(video: readonly SyncPulse[], audio: readonly SyncPulse[], minimumDurationMs: number) {
  // Audio may subscribe before the video decoder produces its first frame.
  // Compare only their common observation interval, with the same 500 ms
  // matching radius used below. Duration/count gates still reject late startup.
  const start = Math.max(video[0]?.atMs ?? Infinity, audio[0]?.atMs ?? Infinity) - 500
  const end = Math.min(video.at(-1)?.atMs ?? -Infinity, audio.at(-1)?.atMs ?? -Infinity) + 500
  const comparedVideo = video.filter(pulse => pulse.atMs >= start && pulse.atMs <= end)
  const comparedAudio = audio.filter(pulse => pulse.atMs >= start && pulse.atMs <= end)
  const pairs = matchPulses(comparedVideo, comparedAudio)
  const percentile = (values: number[], fraction: number) => values.sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0
  const p95AbsoluteSkewMs = percentile(pairs.map(pair => Math.abs(pair.skewMs)), 0.95)
  const first = pairs[0]?.atMs ?? 0, last = pairs.at(-1)?.atMs ?? 0
  const startSkew = percentile(pairs.filter(pair => pair.atMs < first + 60_000).map(pair => pair.skewMs), 0.5)
  const endSkew = percentile(pairs.filter(pair => pair.atMs > last - 60_000).map(pair => pair.skewMs), 0.5)
  const driftMs = Math.abs(endSkew - startSkew)
  const failures: string[] = []
  // Publication/decoder startup and the one-second pulse cadence consume the
  // first few seconds. The 610-second soak still requires over ten full
  // minutes of paired observations; scheduling quantization is not drift.
  if (pairs.length < Math.max(3, minimumDurationMs / 1000 * 0.8) || last - first < minimumDurationMs - 5000) failures.push('insufficient paired pulse duration')
  if (pairs.length < comparedVideo.length * 0.9 || pairs.length < comparedAudio.length * 0.9) failures.push('unmatched coded pulses')
  if (p95AbsoluteSkewMs > 150) failures.push('A/V skew exceeds 150 ms')
  if (minimumDurationMs >= 600_000 && driftMs > 50) failures.push('A/V drift exceeds 50 ms')
  return { accepted: failures.length === 0, failures, p95AbsoluteSkewMs, driftMs,
    comparedAudioPulses: comparedAudio.length, comparedVideoPulses: comparedVideo.length, pairs }
}
