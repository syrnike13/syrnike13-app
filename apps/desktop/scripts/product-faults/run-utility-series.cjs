const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

exports.run = async ({ ui, harness, directory, screenSourceButton, count = 100 }) => {
  if (typeof screenSourceButton !== 'string' || !screenSourceButton.trim()) {
    throw new Error('screen_source_button_is_required')
  }
  mkdirSync(directory)
  const summary = { passed: false, scope: 'utility-replay-authority-and-camera-progress',
    resourceQualification: 'not-assessed', incomingAudioOutput: 'not-measured',
    incomingAudioOutputCycles: 0,
    microphonePrivacyCycles: 0,
    required: count, completed: 0, exhaustionChecks: 0,
    manualRetries: 0, results: [], resources: [] }
  const save = () => writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
  try {
    const initial = await harness.snapshot()
    if (initial.runtime.status !== 'ready' || initial.runtime.restartCount !== 0) {
      throw new Error('fixture_requires_a_fresh_runtime_budget')
    }
    let automaticCrashesSinceManualRetry = 0
    for (let index = 1; index <= count; ++index) {
      let state = await harness.snapshot()
      if (automaticCrashesSinceManualRetry === 2) {
        const exhausted = await harness.crashExhausted(join(directory, `exhaustion-before-${index}.json`),
          state.runtime.restartCount)
        if (!exhausted.passed) throw new Error(`exhaustion_${index}: ${exhausted.failure}`)
        ++summary.exhaustionChecks
        const retried = await harness.manualRetry(join(directory, `manual-retry-before-${index}.json`))
        if (!retried.passed) throw new Error(`manual_retry_${index}: ${retried.failure}`)
        ++summary.manualRetries
        automaticCrashesSinceManualRetry = 0
        state = await harness.snapshot()
      }
      if (state.voice.userMuted) {
        await ui.getByRole('button', { name: 'Включить микрофон', exact: true }).first().click()
      }
      if (state.voice.camera.state !== 'running') {
        await ui.getByRole('button', { name: 'Включить камеру', exact: true }).first().click()
      }
      if (state.voice.screen.state !== 'running') {
        await ui.getByRole('button', { name: 'Демонстрация экрана', exact: true }).first().click()
        await ui.getByRole('button', { name: screenSourceButton, exact: true }).click()
      }
      const before = await harness.until(value => value.voice.connection === 'connected' &&
        !value.voice.userMuted && value.voice.microphone.state === 'running' &&
        value.voice.camera.state === 'running' && value.voice.screen.state === 'running' &&
        value.voice.screenAudio.state === 'running', 'full_media_fixture_deadline', 15000)
      summary.resources.push({ iteration: index, phase: 'before', values: before.processResources })
      const result = await harness.crashLatestMute(join(directory, `utility-${index}.json`))
      summary.results.push({ iteration: index, passed: result.passed, failure: result.failure,
        elapsedMs: result.elapsedMs, hostEpoch: result.after?.runtime.hostEpoch })
      summary.resources.push({ iteration: index, phase: 'after', values: result.after?.processResources })
      if (!result.passed) throw new Error(`utility_${index}: ${result.failure}`)
      if (result.incomingOutputBefore && result.incomingOutputAfter) {
        ++summary.incomingAudioOutputCycles
        summary.incomingAudioOutput = 'sampled-before-and-after-primary-fault'
        summary.scope = 'utility-replay-authority-camera-and-incoming-pcm'
      }
      if (result.microphoneBefore && result.microphoneAfter) ++summary.microphonePrivacyCycles
      ++summary.completed
      ++automaticCrashesSinceManualRetry
      save()
      console.log(JSON.stringify({ utilityCycles: summary.completed, required: count,
        ms: result.elapsedMs, exhaustionChecks: summary.exhaustionChecks }))
    }
    summary.passed = true
  } catch (error) {
    summary.failure = error.message
  } finally {
    save()
  }
  return summary
}
