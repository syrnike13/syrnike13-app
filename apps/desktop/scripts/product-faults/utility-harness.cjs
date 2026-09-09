const { createHash } = require('node:crypto')
const { writeFileSync } = require('node:fs')
const { performance } = require('node:perf_hooks')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const alias = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

exports.createHarness = ({ app, ui, receiver, admin, roomName, channelId, nativeUserId, observerUserId }) => {
  let processOwner

  async function processInventory() {
    if (!processOwner) {
      processOwner = await app.evaluate(({ app }) => ({
        mainPid: process.pid,
        otherUtilities: app.getAppMetrics().filter(value =>
          value.name === 'syrnike-hotkey-runtime' || value.name === 'syrnike-overlay-runtime',
        ).map(value => value.pid),
      }))
    }
    if (![processOwner.mainPid, ...processOwner.otherUtilities].every(value =>
      Number.isSafeInteger(value) && value > 0)) throw new Error('invalid_process_owner')
    const excluded = processOwner.otherUtilities.join(',')
    const script = `$taskOther = @(${excluded}); ` +
      `$taskChildren = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${processOwner.mainPid}'); ` +
      `$taskMedia = @($taskChildren | ` +
      `Where-Object { $_.CommandLine -like '*--utility-sub-type=node.mojom.NodeService*' -and ` +
      `$_.ProcessId -notin $taskOther }); ` +
      `$taskProcesses = @($taskMedia | ForEach-Object { $_.ProcessId }); ` +
      `$taskRenderers = @($taskChildren | Where-Object { $_.CommandLine -like '*--type=renderer*' } | ForEach-Object { $_.ProcessId }); ` +
      `$taskGpus = @($taskChildren | Where-Object { $_.CommandLine -like '*--type=gpu-process*' } | ForEach-Object { $_.ProcessId }); ` +
      `$taskResources = @(@(${processOwner.mainPid}) + $taskProcesses + $taskRenderers + $taskGpus | ForEach-Object { ` +
      `$taskProcess = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($taskProcess) { ` +
      `[pscustomobject]@{ role = $(if ($taskProcess.Id -eq ${processOwner.mainPid}) {'main'} ` +
      `elseif ($taskProcess.Id -in $taskRenderers) {'renderer'} elseif ($taskProcess.Id -in $taskGpus) {'gpu'} else {'media'}); ` +
      `handles = $taskProcess.HandleCount; threads = $taskProcess.Threads.Count; ` +
      `privateBytes = $taskProcess.PrivateMemorySize64; workingSetBytes = $taskProcess.WorkingSet64 } } }); ` +
      `ConvertTo-Json -InputObject @{ processes = $taskProcesses; resources = $taskResources } -Compress`
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 4000, maxBuffer: 16384,
    })
    const inventory = JSON.parse(stdout)
    if (!Array.isArray(inventory.processes) || !inventory.processes.every(value => Number.isSafeInteger(value) && value > 0) ||
        !Array.isArray(inventory.resources) || !inventory.resources.some(value => value.role === 'main')) {
      throw new Error('invalid_process_inventory')
    }
    return inventory
  }

  const actor = identity => {
    const userId = identity.split('|').at(-1)
    return userId === nativeUserId ? 'native' : userId === observerUserId ? 'observer' : 'unexpected'
  }

  async function snapshot() {
    const [client, inventory, participants, videos] = await Promise.all([
      ui.evaluate(async () => {
        const voice = await window.syrnikeDesktop.voice.getSnapshot()
        const runtime = await window.syrnikeDesktop.media.getRuntimeState()
        return {
          voice, runtime,
          video: window.nativeVideoDrawProbe.snapshot(),
        }
      }),
      processInventory(),
      admin.listParticipants(roomName),
      receiver.locator('video').evaluateAll(elements => elements.map(video => ({
        track: video.srcObject?.getVideoTracks()[0]?.id ?? '',
        local: video.srcObject?.getVideoTracks()[0]?.label?.startsWith('fake') ?? false,
        frames: video.getVideoPlaybackQuality().totalVideoFrames,
        width: video.videoWidth, height: video.videoHeight,
      }))),
    ])
    return {
      ...client, processes: inventory.processes, processResources: inventory.resources,
      participants: participants.map(participant => ({
        actor: actor(participant.identity), identity: alias(participant.identity), state: participant.state,
        operation: alias(participant.identity.split('|')[4]),
        connectionEpoch: alias(participant.identity.split('|')[3]),
        tracks: participant.tracks.map(track => ({
          source: track.source, alias: alias(track.sid), muted: track.muted,
        })).sort((left, right) => left.source - right.source || left.alias.localeCompare(right.alias)),
      })),
      receiverVideo: videos.map(video => ({ ...video, track: alias(video.track) })),
    }
  }

  async function until(predicate, label, timeoutMs = 15000, onSample) {
    const deadline = performance.now() + timeoutMs
    let latest
    while (performance.now() < deadline) {
      try { latest = await snapshot() } catch (error) { error.snapshot = latest; throw error }
      try { onSample?.(latest) } catch (error) { error.snapshot = latest; throw error }
      if (predicate(latest)) return latest
      await delay(100)
    }
    const error = new Error(label)
    error.snapshot = latest
    throw error
  }

  function redactSnapshot(value) {
    return {
      ...value,
      voice: {
        ...value.voice,
        intentChannelId: value.voice.intentChannelId ? 'test-channel' : null,
        membershipChannelId: value.voice.membershipChannelId ? 'test-channel' : null,
        operationId: alias(value.voice.operationId),
        connectionEpoch: alias(value.voice.connectionEpoch),
        speakingUserIds: value.voice.speakingUserIds.map(alias),
      },
    }
  }

  async function crashLatestMute(reportPath) {
    const result = {
      passed: false, scope: 'full-product-utility-latest-mute', required: 1,
      processObservation: 'os-node-utility-children-excluding-baseline-hotkey-and-overlay',
    }
    let before
    let stage = 'baseline'
    try {
      // Running can precede the first usable frames after screen selection.
      // Establish the fixture before starting the injected-fault deadline.
      before = await until(value =>
        value.processes.length === 1 && value.voice.connection === 'connected' &&
        value.voice.intentChannelId === channelId && value.voice.membershipChannelId === channelId &&
        !value.voice.userMuted && value.voice.screen.state === 'running' &&
        value.voice.screenAudio.state === 'running' && value.voice.camera.state === 'running' &&
        value.participants.length === 2 &&
        value.participants.filter(participant => participant.actor === 'native').length === 1 &&
        value.participants.filter(participant => participant.actor === 'observer').length === 1 &&
        value.video.some(track => !track.local && track.source === 'camera' &&
          track.metrics?.framesDrawn >= 10 && track.metrics.lastDrawAgeMs < 1000),
      'fixture_not_connected_to_one_utility', 15000)
      const oldPid = before.processes[0]
      const started = performance.now()
      await ui.evaluate(() => {
        window.utilityFaultStates = []
        window.utilityFaultOverflow = false
        window.utilityFaultStateKey = ''
        window.utilityFaultUnsubscribe?.()
        window.utilityFaultUnsubscribe = window.syrnikeDesktop.media.onRuntimeState(state => {
          const value = {
            status: state.status, epoch: state.hostEpoch, failure: state.failure?.code,
            microphone: state.paths.microphone.state,
          }
          const key = JSON.stringify(value)
          if (key === window.utilityFaultStateKey) return
          window.utilityFaultStateKey = key
          if (window.utilityFaultStates.length < 64) window.utilityFaultStates.push(value)
          else window.utilityFaultOverflow = true
        })
      })
      process.kill(oldPid, 'SIGKILL')
      stage = 'intent-update'
      result.intentUpdate = await ui.evaluate(async () => {
        const state = await window.syrnikeDesktop.media.getRuntimeState()
        await window.syrnikeDesktop.voice.dispatch({ type: 'setUserMuted', muted: true })
        await window.syrnikeDesktop.voice.dispatch({ type: 'setUserMuted', muted: false })
        await window.syrnikeDesktop.voice.dispatch({ type: 'setUserMuted', muted: true })
        return { status: state.status, epoch: state.hostEpoch, finalMuted: true }
      })
      if (result.intentUpdate.status === 'ready' && result.intentUpdate.epoch > before.runtime.hostEpoch) {
        throw new Error('intent_change_missed_pending_window')
      }
      result.authoritySamples = []
      stage = 'authority-recovery'
      const recovered = await until(value =>
        value.runtime.hostEpoch > before.runtime.hostEpoch && value.runtime.status === 'ready' &&
        value.processes.length === 1 && value.processes[0] !== oldPid &&
        value.voice.connection === 'connected' && value.voice.userMuted && value.voice.effectiveMuted &&
        value.voice.intentChannelId === channelId && value.voice.membershipChannelId === channelId &&
        value.voice.microphone.state === 'muted' && value.voice.camera.state === 'running' &&
        value.participants.filter(participant => participant.actor === 'native').length === 1 &&
        value.participants.filter(participant => participant.actor === 'observer').length === 1 &&
        value.participants.length === 2 &&
        value.participants.find(participant => participant.actor === 'native')?.operation === alias(value.voice.operationId) &&
        value.participants.find(participant => participant.actor === 'native')?.connectionEpoch === alias(value.voice.connectionEpoch),
      'utility_latest_state_recovery_deadline', 20000, value => {
        if (value.runtime.hostEpoch > before.runtime.hostEpoch + 1 ||
            value.runtime.restartCount > before.runtime.restartCount + 1) {
          throw new Error('unexpected_additional_utility_replacement')
        }
        const native = value.participants.filter(participant => participant.actor === 'native')
        if (native.length > 1 || value.participants.some(participant => participant.actor === 'unexpected')) {
          throw new Error('duplicate_or_unexpected_sfu_participant')
        }
        const sample = {
          connection: value.voice.connection, operation: alias(value.voice.operationId),
          connectionEpoch: alias(value.voice.connectionEpoch), hostEpoch: value.runtime.hostEpoch,
          nativeParticipants: native.map(participant => ({
            operation: participant.operation, connectionEpoch: participant.connectionEpoch,
          })),
        }
        if (JSON.stringify(sample) === JSON.stringify(result.authoritySamples.at(-1))) return
        if (result.authoritySamples.length === 64) throw new Error('authority_trace_capacity')
        result.authoritySamples.push(sample)
      })
      result.after = redactSnapshot(recovered)
      stage = 'authority-validation'
      if (recovered.voice.operationId === before.voice.operationId ||
          recovered.voice.connectionEpoch === before.voice.connectionEpoch) {
        throw new Error('voice_authority_did_not_replace_lost_room')
      }
      const nativeAfter = recovered.participants.find(participant => participant.actor === 'native')
      if (nativeAfter.operation !== alias(recovered.voice.operationId) ||
          nativeAfter.connectionEpoch !== alias(recovered.voice.connectionEpoch)) {
        throw new Error('sfu_participant_does_not_match_voice_authority')
      }
      const observerBefore = before.participants.find(participant => participant.actor === 'observer')
      const observerAfter = recovered.participants.find(participant => participant.actor === 'observer')
      if (JSON.stringify(observerBefore) !== JSON.stringify(observerAfter)) {
        throw new Error('unaffected_observer_changed')
      }
      stage = 'video-progress'
      const progress = await until(value => {
        const incoming = value.video.find(track => !track.local && track.source === 'camera')?.metrics
        const outgoing = value.receiverVideo.find(video => !video.local && video.width > 0)
        const earlier = recovered.receiverVideo.find(video => video.track === outgoing?.track)
        return incoming?.framesDrawn >= 10 && incoming.lastDrawAgeMs < 1000 &&
          outgoing && outgoing.frames >= (earlier?.frames ?? 0) + 10
      }, 'utility_bidirectional_video_deadline', 10000)
      let oldProcessAlive = false
      try { process.kill(oldPid, 0); oldProcessAlive = true } catch {}
      if (oldProcessAlive) throw new Error('retired_utility_still_alive')
      result.passed = true
      result.elapsedMs = performance.now() - started
      result.before = redactSnapshot(before)
      result.after = redactSnapshot(progress)
    } catch (error) {
      result.failure = error.message
      result.failureStage = stage
      if (before) result.before = redactSnapshot(before)
      if (error.snapshot) result.after = redactSnapshot(error.snapshot)
    } finally {
      const trace = await ui.evaluate(() => {
        window.utilityFaultUnsubscribe?.()
        return { states: window.utilityFaultStates ?? [], overflow: window.utilityFaultOverflow ?? false }
      })
      result.runtimeTransitions = trace.states
      result.violations = []
      if (before && trace.states.some(state => state.epoch > before.runtime.hostEpoch + 1)) {
        result.passed = false
        result.violations.push('unexpected_additional_utility_replacement')
        result.failure ??= 'unexpected_additional_utility_replacement'
      }
      if (trace.overflow) {
        result.passed = false
        result.violations.push('runtime_trace_capacity')
        result.failure ??= 'runtime_trace_capacity'
      }
      if (before && trace.states.some(state => state.epoch > before.runtime.hostEpoch &&
          state.status === 'ready' && state.microphone === 'running')) {
        result.passed = false
        result.violations.push('new_host_ready_with_old_running_projection')
        result.failure ??= 'new_host_ready_with_old_running_projection'
      }
      writeFileSync(reportPath, JSON.stringify(result, null, 2))
    }
    return result
  }

  async function crashExhausted(reportPath, expectedRestartCount = 2) {
    const result = { passed: false, scope: 'full-product-utility-exhausted-budget', observationMs: 3500 }
    try {
      const before = await snapshot()
      result.before = redactSnapshot(before)
      if (before.runtime.restartCount !== expectedRestartCount || before.runtime.status !== 'ready' || before.processes.length !== 1) {
        throw new Error('fixture_retry_budget_not_exhausted')
      }
      await ui.evaluate(() => {
        window.exhaustedFaultStates = []
        window.exhaustedFaultOverflow = false
        window.exhaustedFaultUnsubscribe?.()
        window.exhaustedFaultUnsubscribe = window.syrnikeDesktop.media.onRuntimeState(state => {
          const value = { status: state.status, epoch: state.hostEpoch, restartCount: state.restartCount, failure: state.failure?.code }
          const previous = window.exhaustedFaultStates.at(-1)
          if (JSON.stringify(value) === JSON.stringify(previous)) return
          if (window.exhaustedFaultStates.length < 64) window.exhaustedFaultStates.push(value)
          else window.exhaustedFaultOverflow = true
        })
      })
      process.kill(before.processes[0], 'SIGKILL')
      const settled = await until(value => value.runtime.status === 'failed' ||
        value.runtime.hostEpoch > before.runtime.hostEpoch, 'exhausted_host_terminal_deadline', 10000)
      result.after = redactSnapshot(settled)
      if (settled.runtime.hostEpoch > before.runtime.hostEpoch) throw new Error('automatic_restart_after_exhausted_budget')
      const deadline = performance.now() + result.observationMs
      while (performance.now() < deadline) {
        const current = await snapshot()
        result.after = redactSnapshot(current)
        if (current.runtime.status !== 'failed' || current.runtime.hostEpoch !== before.runtime.hostEpoch || current.processes.length) {
          throw new Error('exhausted_runtime_did_not_remain_terminal')
        }
        await delay(100)
      }
      result.manualRetryVisible = await ui.getByRole('button', { name: 'Повторить запуск', exact: true }).isVisible()
      if (!result.manualRetryVisible) throw new Error('manual_runtime_retry_not_available')
      result.passed = true
    } catch (error) {
      result.failure = error.message
      if (error.snapshot) result.after = redactSnapshot(error.snapshot)
    } finally {
      const trace = await ui.evaluate(() => {
        window.exhaustedFaultUnsubscribe?.()
        return { states: window.exhaustedFaultStates ?? [], overflow: window.exhaustedFaultOverflow ?? false }
      })
      result.runtimeTransitions = trace.states
      if (trace.overflow) { result.passed = false; result.failure ??= 'runtime_trace_capacity' }
      writeFileSync(reportPath, JSON.stringify(result, null, 2))
    }
    return result
  }

  async function manualRetry(reportPath) {
    const result = { passed: false, scope: 'full-product-explicit-runtime-retry' }
    try {
      const before = await snapshot()
      result.before = redactSnapshot(before)
      if (before.runtime.status !== 'failed' || before.processes.length !== 0) throw new Error('runtime_not_terminal')
      const started = performance.now()
      await ui.getByRole('button', { name: 'Повторить запуск', exact: true }).click()
      const after = await until(value => value.runtime.status === 'ready' &&
        value.runtime.hostEpoch === before.runtime.hostEpoch + 1 && value.processes.length === 1 &&
        value.voice.connection === 'connected', 'manual_retry_recovery_deadline', 20000)
      result.after = redactSnapshot(after)
      const observerBefore = before.participants.find(participant => participant.actor === 'observer')
      const observerAfter = after.participants.find(participant => participant.actor === 'observer')
      if (JSON.stringify(observerBefore) !== JSON.stringify(observerAfter)) throw new Error('unaffected_observer_changed')
      result.elapsedMs = performance.now() - started
      result.passed = true
    } catch (error) {
      result.failure = error.message
      if (error.snapshot) result.after = redactSnapshot(error.snapshot)
    } finally { writeFileSync(reportPath, JSON.stringify(result, null, 2)) }
    return result
  }

  return { snapshot, until, crashLatestMute, crashExhausted, manualRetry }
}
