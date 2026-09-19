const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { runCombinedFault } = require('./combined-harness.cjs')

exports.run = async ({ directory, count = 100, ...fixture }) => {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100)
    throw new Error('combined_iteration_count_out_of_bounds')
  mkdirSync(directory)
  const summary = {
    passed: false,
    scope: 'full-product-combined-media-continuity',
    resourceQualification: 'process-samples-and-texture-bound',
    required: count,
    completed: 0,
    results: [],
  }
  const save = () => writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
  try {
    for (let iteration = 1; iteration <= count; ++iteration) {
      const result = await runCombinedFault({
        ...fixture,
        reportPath: join(directory, `combined-${iteration}.json`),
      })
      summary.results.push({
        iteration, passed: result.passed, failure: result.failure,
        detectionMs: result.detectionMs, audioRecoveryMs: result.audioRecoveryMs,
        presentationRecoveryMs: result.presentationRecoveryMs,
        maximumSilenceUpperBoundMs: result.maximumSilenceUpperBoundMs,
        neutralMaximumGapMs: result.neutralObserver?.maximumGapMs,
        elapsedMs: result.elapsedMs,
      })
      if (!result.passed) throw new Error(`combined_${iteration}: ${result.failure}`)
      ++summary.completed
      save()
      console.log(JSON.stringify({ combinedCycles: summary.completed, required: count,
        detectionMs: result.detectionMs, audioRecoveryMs: result.audioRecoveryMs }))
    }
    summary.passed = true
  } catch (error) {
    summary.failure = error.message
  } finally {
    save()
  }
  return summary
}
