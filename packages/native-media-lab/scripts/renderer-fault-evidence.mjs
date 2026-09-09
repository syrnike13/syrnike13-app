const ids = ['renderer-reload', 'renderer-crash']
const sources = ['microphone', 'screen', 'screen_audio', 'camera']

// Keep two aggregate rows and one current publication snapshot. No per-frame
// history or raw participant/publication identifiers enter the report.
export function createRendererFaultEvidence() {
  const rows = []
  const violations = new Set()
  let active
  let previous = []
  let completions = 0
  const snapshot = publications => publications.map(({ source, alias, frames, unsubscribed }) =>
    ({ source, alias, frames, unsubscribed }))
  const validSources = publications => publications.length === sources.length &&
    sources.every(source => publications.filter(value => value.source === source && !value.unsubscribed).length === 1)
  return {
    observeGap(gapMs) {
      if (active) active.maximumReceiverGapMs = Math.max(active.maximumReceiverGapMs, gapMs)
    },
    record(event, publications) {
      if (event?.event === 'begin') {
        if (event.id !== ids[rows.length] || (active && completions !== 100)) {
          violations.add('unexpected-fault-start')
          return
        }
        active = { id: event.id, passed: 0, required: 100, maximumIterationMs: 0,
          maximumReceiverGapMs: 0, minimumFrameProgress: null }
        rows.push(active)
        completions = 0
        previous = snapshot(publications)
        if (!validSources(previous)) violations.add('missing-or-duplicate-publication')
        return
      }
      if (!active || event?.id !== active.id || event.event !== 'completed' ||
          event.iteration !== completions || completions >= 100 ||
          !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) {
        violations.add('unexpected-fault-completion')
        return
      }
      const current = snapshot(publications)
      const progress = sources.map(source => {
        const before = previous.find(value => value.source === source)
        const after = current.find(value => value.source === source)
        return before && after && before.alias === after.alias && !after.unsubscribed
          ? after.frames - before.frames : 0
      })
      const minimum = Math.min(...progress)
      const passed = validSources(current) && minimum > 0 && active.maximumReceiverGapMs <= 1500
      if (passed) ++active.passed
      else violations.add('observer-continuity-failed')
      ++completions
      active.maximumIterationMs = Math.max(active.maximumIterationMs, event.elapsedMs)
      active.minimumFrameProgress = Math.min(active.minimumFrameProgress ?? minimum, minimum)
      previous = current
      if (completions === 100) active = undefined
    },
    result() {
      return { passed: violations.size === 0 && rows.length === ids.length && rows.every(row => row.passed === 100),
        rows: rows.map(row => ({ ...row })), violations: [...violations] }
    },
  }
}
