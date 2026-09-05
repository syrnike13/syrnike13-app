export function verifyPreview(preview, observer, scenario) {
  const errors = []
  const check = (ok, message) => { if (!ok) errors.push(message) }
  check(preview.failures.length === 0 && observer.failures.length === 0, 'Harness/observer failure')
  check(observer.subscriptions.length === 1 && observer.reconnects === 0, 'Publication or Room restarted')
  check(observer.frames >= 120 && observer.averageFps >= 20, 'Observer delivery below 20 FPS budget')
  check(observer.p95AgeMs !== null && observer.p95AgeMs < 250, 'Observer p95 capture age >= 250ms')
  check(observer.maximumGapMs < 500, 'Observer interruption >= 500ms')
  const steady = observer.samples.slice(2, -1)
  check(steady.length >= 3 && steady.every(sample => sample.frames >= 15), 'Observer sustained delivery below 15 FPS')
  check(preview.frames > 20, 'Preview did not render source frames')
  const samples = preview.samples
  check(samples.length > 10 && samples.every(sample => sample.backingBytes <= 8 * 1024 * 1024 &&
    sample.outstanding + sample.pending + sample.quarantined <= 2), 'Preview texture bound exceeded')
  check(samples.every(sample => sample.sdkReconnects === 0 && sample.publicationFailures === 0 &&
    sample.encoderStalls === 0 && sample.publicationDepth <= 2 && sample.publicationBytes <= 192 * 1024 * 1024), 'Publication became unhealthy')
  const running = samples.filter(sample => sample.publicationConsumed > 30 && !sample.done)
  check(running.every(sample => sample.sdkConnected), 'SDK Room disconnected')
  check(preview.final?.done && preview.final.backingBytes === 0 && preview.outstanding === 0 &&
    preview.final.outstanding === 0 && preview.final.pending === 0 && preview.final.quarantined === 0,
  'Preview resources leaked after stop')
  check(preview.final?.captureActive === 0 && preview.final.capturePending === 0 &&
    preview.final.conversionSlots === 0 && preview.final.encoderInputSlots === 0 &&
    preview.final.encoderOutputSlots === 0 && preview.final.publicationDepth === 0, 'Publication resources leaked')
  if (['slow', 'never-release', 'late-join', 'publication-stop'].includes(scenario))
    check(preview.final.poolDrops > 0, 'Broken preview did not produce bounded drops')
  if (['never-release', 'late-join', 'publication-stop'].includes(scenario)) {
    const stalled = samples.filter(sample => sample.rendererHeld === 2 && sample.outstanding === 2)
    check(stalled.length >= 20 && stalled.at(-1).publicationConsumed - stalled[0].publicationConsumed >= 60,
      'Publication progress while preview stalled was not proven')
    if (stalled.length) check(stalled.every(sample => sample.accepted === stalled[0].accepted), 'Stalled preview kept allocating frames')
  }
  if (scenario === 'pressure') {
    const pressured = samples.filter(sample => sample.pressureDrops > 0 && sample.publicationActive)
    check(pressured.length > 20 && pressured.at(-1).publicationConsumed - pressured[0].publicationConsumed >= 60,
      'Publication did not progress under preview pressure')
    check(pressured.at(-1)?.backingBytes === 0, 'Preview did not yield its allocation under pressure')
  }
  if (scenario === 'cycles') check(preview.cycles === 100, '100 preview cycles not completed')
  if (scenario === 'slow') {
    const transition = preview.transitions.find(item => item.phase === 'slow')
    const slowed = samples.filter(sample => transition && sample.time > transition.time + 1000 && !sample.done)
    const seconds = slowed.length ? (slowed.at(-1).time - slowed[0].time) / 1000 : 0
    const frames = slowed.length ? slowed.at(-1).frames - slowed[0].frames : 0
    check(seconds >= 5 && frames >= seconds * 0.7 && frames <= seconds + 2, 'Preview consumer did not run at 1 FPS')
  }
  if (scenario === 'resize') check(observer.sourceSizes.length >= 2, 'Source resize not observed remotely')
  if (['reload', 'close'].includes(scenario)) {
    const transition = preview.transitions.find(item => item.phase === scenario)
    check(transition && preview.frames - transition.frames > 20, 'Preview did not recover after renderer loss')
  }
  return errors
}
