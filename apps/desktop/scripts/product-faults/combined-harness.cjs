const { readFileSync, writeFileSync, statSync } = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { startProbe } = require('./probe-process.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate, label, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error(label)
}

function presentationEvidence(directory, sinceMs) {
  const values = []
  for (const name of ['electron-main.1.jsonl', 'electron-main.jsonl']) {
    const file = path.join(directory, name)
    let text
    try {
      if (statSync(file).size > 4_300_000) throw new Error('presentation_log_capacity')
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT' && name.includes('.1.')) continue
      throw error
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"presentation_metrics"')) continue
      let row
      try { row = JSON.parse(line) } catch { continue } // A writer may have an incomplete final line.
      if (row.event !== 'presentation_metrics' || row.timestamp_ms < sinceMs) continue
      const metrics = row.data?.payload
      if (!metrics || !['retained', 'awaitingReceiverRelease', 'activeLeases', 'retiredLeases'].every(
        key => Number.isSafeInteger(metrics[key]) && metrics[key] >= 0) ||
        !Object.values(metrics).every(value => Number.isSafeInteger(value) && value >= 0))
        throw new Error('presentation_metrics_invalid')
      values.push(metrics)
      if (values.length > 64) throw new Error('presentation_evidence_capacity')
    }
  }
  if (values.length < 2 || !values.some(value => value.awaitingReceiverRelease >= 2) ||
      values.some(value => value.retained > 68 || value.activeLeases + value.retiredLeases > 68))
    throw new Error('presentation_retention_evidence_failed')
  return values
}

function publicSnapshot(value) {
  return {
    runtime: value.runtime,
    participants: value.participants,
    resources: value.processResources,
    video: value.video,
    receiverVideo: value.receiverVideo,
  }
}

const participantFingerprint = value => JSON.stringify([...value.participants].sort(
  (left, right) => left.identity.localeCompare(right.identity)))

exports.runCombinedFault = async ({ app, ui, receiver, harness, observer, audioProbe, gpuProbe,
  diagnosticDirectory, reportPath }) => {
  const result = { passed: false, scope: 'full-product-combined-media-continuity',
    resourceQualification: 'process-samples-and-texture-bound', audioWindowMs: 100 }
  let audio
  let gpu
  let observerActive = false
  try {
    const before = await harness.until(value => value.processes.length === 1 &&
      value.voice.connection === 'connected' && !value.voice.userMuted &&
      value.participants.length === 3 && ['native', 'observer', 'neutral-observer'].every(
        actor => value.participants.filter(participant => participant.actor === actor).length === 1) &&
      value.video.some(track => track.local && track.source === 'screen' && track.metrics.lastDrawAgeMs < 1_000) &&
      value.video.some(track => !track.local && track.source === 'camera' && track.metrics.lastDrawAgeMs < 1_000) &&
      ['camera', 'microphone', 'output', 'screen', 'screen_audio', 'screen_preview'].every(
        key => value.runtime.paths[key]?.state === 'running'), 'combined_fixture_not_ready', 15_000)
    result.before = publicSnapshot(before)
    const mainPid = await app.evaluate(() => process.pid)
    gpu = startProbe({ executable: gpuProbe, args: ['8000'],
      prefixes: ['GPU_CONTENTION_READY', 'GPU_CONTENTION_RESULT'] })
    await gpu.take(event => event.type === 'GPU_CONTENTION_READY', 'gpu_fixture_start', 5_000)
    audio = startProbe({ executable: audioProbe, args: ['include', String(mainPid), '6500', '1', 'timeline'],
      prefixes: ['AUDIO_CAPTURE_READY', 'AUDIO_CAPTURE_WINDOW', 'AUDIO_CAPTURE_SAMPLE'] })
    await audio.take(event => event.type === 'AUDIO_CAPTURE_READY', 'audio_fixture_start', 3_000)
    const nextWindow = () => audio.take(event => event.type === 'AUDIO_CAPTURE_WINDOW', 'audio_window_deadline', 1_500)
    let activeWindows = 0
    for (let count = 0; count < 10 && activeWindows < 2; ++count) {
      const window = await nextWindow()
      activeWindows = window.activePackets >= 5 ? activeWindows + 1 : 0
    }
    if (activeWindows !== 2) throw new Error('combined_audio_baseline_missing')
    observer.command('begin')
    observerActive = true
    await observer.take(event => event.type === 'PRODUCT_OBSERVER_RESULT' && event.value.event === 'begin',
      'neutral_observer_begin')

    const started = performance.now()
    const startedAt = Date.now()
    await ui.evaluate(() => window.rendererReleaseProbe.start())
    await until(() => ui.evaluate(() => window.rendererReleaseProbe.snapshot().held === 2),
      'renderer_hold_not_observed', 1_000)
    await receiver.evaluate(() => window.toneMicrophoneFixture.setSilent(true))
    let silentWindows = 0
    for (let count = 0; count < 10 && silentWindows < 3; ++count) {
      const window = await nextWindow()
      silentWindows = window.packets >= 5 && window.activePackets === 0 ? silentWindows + 1 : 0
    }
    if (silentWindows !== 3) throw new Error('injected_audio_gap_not_observed')
    const audioResumed = performance.now()
    await receiver.evaluate(() => window.toneMicrophoneFixture.setSilent(false))
    activeWindows = 0
    for (let count = 0; count < 10 && activeWindows < 2; ++count) {
      const window = await nextWindow()
      activeWindows = window.activePackets >= 5 ? activeWindows + 1 : 0
    }
    result.audioRecoveryMs = performance.now() - audioResumed
    if (activeWindows !== 2 || result.audioRecoveryMs > 1_500)
      throw new Error('combined_audio_recovery_deadline')
    await until(async () => (await ui.evaluate(() => window.syrnikeDesktop.media.getRuntimeState()))
      .paths.screen_preview.failure?.code === 'video_bridge_receiver_release_timeout',
    'renderer_release_stall_not_detected', Math.max(1, 3_000 - (performance.now() - started)))
    result.detectionMs = performance.now() - started
    if (result.detectionMs > 3_000) throw new Error('renderer_release_detection_deadline')
    result.held = await ui.evaluate(() => window.rendererReleaseProbe.snapshot())
    if (result.held.held !== 2 || result.held.overflow) throw new Error('renderer_hold_capacity_failed')
    const releasing = performance.now()
    await ui.evaluate(() => window.rendererReleaseProbe.release())
    await until(async () => {
      const state = await ui.evaluate(() => window.syrnikeDesktop.media.getRuntimeState())
      return state.paths.screen_preview.state === 'running'
    }, 'renderer_release_recovery_deadline', 3_000)
    result.presentationRecoveryMs = performance.now() - releasing
    result.audio = await audio.take(event => event.type === 'AUDIO_CAPTURE_SAMPLE', 'audio_capture_completion', 8_000)
    await audio.finished(2_000)
    let silentRun = 0
    let maximumSilentWindows = 0
    for (const window of result.audio.windows ?? []) {
      silentRun = window.activePackets === 0 ? silentRun + 1 : 0
      maximumSilentWindows = Math.max(maximumSilentWindows, silentRun)
    }
    result.maximumSilentWindowSpanMs = maximumSilentWindows * 100
    // The adjacent active windows can each hide at most one window's silence.
    result.maximumSilenceUpperBoundMs = (maximumSilentWindows + 2) * 100
    if (result.audio.failure !== -1 || result.audio.clientsAfterStop !== 0 || result.audio.threadsAfterStop !== 0 ||
        result.audio.windows?.length !== 65 || result.maximumSilenceUpperBoundMs > 1_500 ||
        !result.audio.windows.slice(-3).every(window => window.activePackets >= 5))
      throw new Error('continuous_output_evidence_failed')
    result.gpu = await gpu.take(event => event.type === 'GPU_CONTENTION_RESULT', 'gpu_completion', 5_000)
    await gpu.finished(2_000)
    if (result.gpu.batches < 2 || result.gpu.allocatedBytes !== 16_777_216 || result.gpu.maximumOutstandingDispatches !== 1)
      throw new Error('gpu_contention_evidence_failed')
    observer.command('finish')
    result.neutralObserver = await observer.take(event => event.type === 'PRODUCT_OBSERVER_RESULT' &&
      event.value.event === 'finish', 'neutral_observer_finish')
    observerActive = false
    if (!result.neutralObserver.passed) throw new Error('neutral_observer_continuity_failed')
    const after = await harness.snapshot()
    result.after = publicSnapshot(after)
    if (after.voice.connection !== 'connected' || after.voice.operationId !== before.voice.operationId ||
        after.voice.connectionEpoch !== before.voice.connectionEpoch || after.runtime.hostEpoch !== before.runtime.hostEpoch ||
        after.runtime.restartCount !== before.runtime.restartCount || after.processes.length !== 1 ||
        after.processes[0] !== before.processes[0] || participantFingerprint(after) !== participantFingerprint(before) ||
        !['camera', 'microphone', 'output', 'screen', 'screen_audio', 'screen_preview'].every(
          key => after.runtime.paths[key]?.state === 'running'))
      throw new Error('combined_fault_changed_media_authority')
    const previousScreen = before.video.find(track => track.local && track.source === 'screen')
    const currentScreen = after.video.find(track => track.local && track.source === 'screen')
    if (!previousScreen || !currentScreen || currentScreen.metrics.framesDrawn <= previousScreen.metrics.framesDrawn ||
        currentScreen.metrics.lastDrawAgeMs > 1_000) throw new Error('local_presentation_did_not_resume')
    const currentIncoming = value => value.video.filter(track => !track.local && track.source === 'camera')
      .sort((left, right) => left.metrics.lastDrawAgeMs - right.metrics.lastDrawAgeMs)[0]
    const previousRemote = currentIncoming(before)
    const currentRemote = currentIncoming(after)
    if (!previousRemote || !currentRemote || currentRemote.metrics.framesDrawn <= previousRemote.metrics.framesDrawn ||
        currentRemote.metrics.lastDrawAgeMs > 1_000) throw new Error('incoming_presentation_did_not_resume')
    result.presentation = presentationEvidence(diagnosticDirectory, startedAt)
    result.elapsedMs = performance.now() - started
    result.passed = true
  } catch (error) {
    result.failure = error.message
  } finally {
    if (observerActive) {
      try {
        observer.command('finish')
        result.neutralObserver = await observer.take(event => event.type === 'PRODUCT_OBSERVER_RESULT' &&
          event.value.event === 'finish', 'neutral_observer_cleanup')
      } catch { result.failure ??= 'neutral_observer_cleanup_failed' }
    }
    const cleanup = await Promise.allSettled([audio?.stop(), gpu?.stop(),
      receiver.evaluate(() => window.toneMicrophoneFixture.setSilent(false)),
      ui.evaluate(() => window.rendererReleaseProbe.release())])
    if (cleanup.some(value => value.status === 'rejected')) {
      result.passed = false
      result.failure ??= 'combined_fixture_cleanup_failed'
    }
    writeFileSync(reportPath, JSON.stringify(result, null, 2))
  }
  return result
}
