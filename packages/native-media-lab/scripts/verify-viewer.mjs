/** Acceptance checks over bounded viewer telemetry, independent of process exit. */
export function verifyViewer(report, scenario, seconds) {
  const errors = []
  const check = (condition, message) => { if (!condition) errors.push(message) }
  const samples = report.samples
  check(report.frames > 0 && report.failures.length === 0, 'No successful presentation or runtime failure')
  check(report.pending === 0 && report.final?.backingBytes === 0, 'Outstanding leases/backing after teardown')
  check(report.final?.room === 'connected', 'Renderer teardown affected Room')
  check(samples.length > 1, 'Insufficient telemetry')
  check(samples.every(sample => sample.backingBytes <= 256 * 1024 * 1024 &&
    sample.delivered + sample.retired + sample.quarantined <= 4), 'Pool bound exceeded')
  const connected = samples.findIndex(sample => sample.room === 'connected')
  check(connected >= 0 && samples.slice(connected).every(sample => sample.room === 'connected'), 'Room lost during scenario')
  const transitions = report.transitions
  if (scenario === 'stall' || scenario === 'slow') {
    const start = transitions.find(item => item.phase === scenario)
    const resume = transitions.find(item => item.phase === 'resume')
    check(Boolean(start && resume && report.frames > resume.frames), 'Missing resume progress')
    if (scenario === 'stall') {
      check(Boolean(start && resume && resume.time - start.time >= 29900), 'Stall shorter than 30 seconds')
      const held = samples.filter(sample => sample.phase === 'stall' && sample.delivered === 4)
      check(held.length >= 25 && held.every(sample => sample.accepted === held[0].accepted &&
        sample.backingBytes === held[0].backingBytes) && held.at(-1).decoded > held[0].decoded,
      'Stall did not preserve fixed backing while decoding continued')
    }
    check(report.final?.latencyP95Ms < 250, 'Resume retained stale backlog')
  }
  if (scenario === 'cycles') {
    check(transitions.filter(item => /^off-\d+$/.test(item.phase)).length === 30 &&
      transitions.filter(item => /^on-\d+$/.test(item.phase)).length === 30 &&
      transitions.some(item => item.phase === 'cycles-complete'), 'Incomplete 30-cycle run')
  }
  if (['reload', 'crash', 'close'].includes(scenario)) {
    const transition = transitions.find(item => item.phase === scenario)
    check(Boolean(transition && report.frames > transition.frames), 'No presentation after renderer restart')
  }
  if (scenario === 'replace') {
    const gap = samples.findIndex(sample => sample.presented > 0 && sample.backingBytes === 0)
    check(gap >= 0 && samples.slice(gap + 1).some(sample =>
      sample.generation > samples[gap].generation && sample.presented > samples[gap].presented),
    'Missing unpublish/replacement recovery')
  }
  if (scenario === 'normal' && seconds >= 600) {
    check(samples.at(-1)?.time - samples[0]?.time >= 600000, 'Run shorter than ten minutes')
    const active = samples.filter(sample => sample.time > samples[0].time + 30000 && sample.backingBytes > 0)
    check(active.length >= 550 && active.every(sample => sample.latencyP95Ms < 250), 'Sustained ingress latency exceeded 250 ms')
    check(active.length > 0 && Math.max(...active.map(sample => sample.backingBytes)) <= 4 * 8323072,
      '1080p backing exceeded four aligned textures')
    check(active.length > 0 && active.at(-1).presented > active[0].presented, 'No sustained presentation')
  }
  return errors
}
