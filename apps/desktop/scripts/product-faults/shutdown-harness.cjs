const { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const shutdownBudgetMs = 4900
// Browser/SDK exception text can contain private URLs or identities. Reports
// retain our fixed failure codes; detailed caller diagnostics stay separate.
const failureCode = error => typeof error?.message === 'string' && /^[a-z0-9_]{1,96}$/.test(error.message)
  ? error.message : 'shutdown_scenario_failed'

// The caller supplies a real product launch and UI scenario. A marker alone is
// insufficient: its PID must be the selected app's current native utility.
exports.run = async ({ directory, mediaRoot, broker, launch, enterFault, inventory, point, call = 1, precondition, count = 100 }) => {
  if (!/^[a-z-]{1,64}$/.test(point) || !Number.isInteger(call) || call < 1 || call > 100000 ||
      !Number.isInteger(count) || count < 1 || count > 100) throw new Error('invalid_shutdown_fixture')
  if (precondition && (!/^[a-z-]{1,64}$/.test(precondition.point) || precondition.point === point ||
      !Number.isInteger(precondition.call) || precondition.call < 1 || precondition.call > 100000))
    throw new Error('invalid_shutdown_precondition')
  const selections = [...(precondition ? [precondition] : []), { point, call }]
  const root = resolve(mediaRoot, '..')
  const configuration = join(root, 'native-test-fault.txt')
  if (existsSync(configuration)) throw new Error('shutdown_fault_configuration_exists')
  if (readdirSync(root).some(name => /^native-test-fault-held-\d+(?:-[a-z-]+)?\.json$/.test(name)))
    throw new Error('shutdown_fault_markers_already_exist')
  mkdirSync(directory)
  const summary = { scope: 'full-product-shutdown-with-held-native-call', point, call,
    precondition, passed: false, required: count, completed: 0, shutdownBudgetMs, results: [] }
  const save = () => writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
  try {
    for (let iteration = 1; iteration <= count; ++iteration) {
      let app
      let state
      let markerPaths = []
      let references = []
      let expectedConfiguration
      let createdConfiguration = false
      const result = { point, call, iteration, passed: false, shutdownBudgetMs }
      try {
        expectedConfiguration = selections.map(selection => `${selection.point}\n${selection.call}\n`).join('')
        writeFileSync(configuration, expectedConfiguration, { flag: 'wx' })
        createdConfiguration = true
        app = await launch()
        state = await inventory(app)
        if (state.mediaPids.length !== 1) throw new Error('shutdown_fixture_utility_count')
        const pids = [state.mainPid, ...state.mediaPids]
        if (!pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) throw new Error('invalid_shutdown_process')
        for (const pid of pids) references.push(broker.openReceiverProcess(pid))
        markerPaths = selections.map(selection =>
          join(root, `native-test-fault-held-${state.mediaPids[0]}-${selection.point}.json`))
        result.entries = []
        const waitForPoint = async requestedPoint => {
          const index = selections.findIndex(selection => selection.point === requestedPoint)
          if (index < 0) throw new Error('unconfigured_shutdown_point')
          const selection = selections[index]
          const deadline = performance.now() + 15000
          let marker
          while (performance.now() < deadline) {
            if (references.some(reference => reference.hasExited())) throw new Error('fault_process_exited_before_shutdown')
            if (existsSync(markerPaths[index])) {
              const text = readFileSync(markerPaths[index], 'utf8')
              if (text.length > 256) throw new Error('native_fault_marker_capacity')
              // Creation can be observed before the writer finishes. A
              // complete line commits this small, bounded entry record.
              if (text.endsWith('\n')) { marker = JSON.parse(text); break }
            }
            await delay(20)
          }
          if (!marker) throw new Error('native_fault_entry_deadline')
          if (marker.point !== selection.point || marker.call !== selection.call || marker.pid !== state.mediaPids[0])
            throw new Error('native_fault_entry_mismatch')
          const entry = { point: marker.point, call: marker.call, ownedUtilityVerified: true }
          if (!result.entries.some(value => value.point === marker.point)) result.entries.push(entry)
          return entry
        }
        await enterFault(app, point, waitForPoint)
        result.entry = await waitForPoint(point)
        if (precondition && !result.entries.some(entry => entry.point === precondition.point))
          throw new Error('shutdown_precondition_not_observed')
        if (references.some(reference => reference.hasExited())) throw new Error('fault_process_exited_before_shutdown')
        const started = performance.now()
        let closeSettled = false
        let closeFailed = false
        let closeElapsedMs = null
        const firstObservedExitMs = references.map(() => null)
        const closing = app.close().then(() => {
          closeElapsedMs = performance.now() - started
          closeSettled = true
        }, () => {
          closeElapsedMs = performance.now() - started
          closeFailed = true
        })
        while (true) {
          // Sample every retained handle even while the close observer is pending.
          for (const [index, reference] of references.entries()) {
            const exited = reference.hasExited()
            if (exited && firstObservedExitMs[index] === null)
              firstObservedExitMs[index] = performance.now() - started
          }
          if (closeFailed || (closeSettled && firstObservedExitMs.every(elapsed => elapsed !== null)) ||
              performance.now() - started >= shutdownBudgetMs) break
          await delay(5)
        }
        result.elapsedMs = performance.now() - started
        result.closeSettled = closeSettled
        result.closeFailed = closeFailed
        result.closeElapsedMs = closeElapsedMs
        result.firstObservedExitMs = firstObservedExitMs
        result.processesExited = firstObservedExitMs.map(elapsed => elapsed !== null)
        result.completionElapsedMs = closeSettled && result.processesExited.every(Boolean)
          ? Math.max(closeElapsedMs, ...firstObservedExitMs) : null
        if (closeFailed || !closeSettled || result.processesExited.some(exited => !exited) ||
            result.completionElapsedMs > shutdownBudgetMs) throw new Error('product_shutdown_deadline')
        await closing
        result.passed = true
      } catch (error) {
        result.failure = failureCode(error)
      } finally {
        // Only failed fixtures need a test-side kill. Record that cleanup and
        // never count it as proof of the application's shutdown boundary.
        result.forcedFixtureCleanup = false
        if (state) {
          for (const [index, pid] of [state.mainPid, ...state.mediaPids].entries()) {
            try {
              if (references[index]?.hasExited()) continue
              process.kill(pid, 0)
              result.forcedFixtureCleanup = true
              process.kill(pid, 'SIGKILL')
            } catch {}
          }
          const cleanupDeadline = performance.now() + 2000
          while (references.some(reference => !reference.hasExited()) && performance.now() < cleanupDeadline)
            await delay(5)
          if (references.some(reference => !reference.hasExited())) {
            result.passed = false
            result.failure ??= 'shutdown_fixture_cleanup_deadline'
          }
        } else if (app) {
          result.forcedFixtureCleanup = true
          app.process().kill('SIGKILL')
        }
        for (const reference of references) reference.close()
        for (const markerPath of markerPaths) if (existsSync(markerPath)) unlinkSync(markerPath)
        if (createdConfiguration && existsSync(configuration)) {
          if (readFileSync(configuration, 'utf8') !== expectedConfiguration) {
            result.passed = false
            result.failure ??= 'shutdown_configuration_changed'
          } else unlinkSync(configuration)
        }
        writeFileSync(join(directory, `shutdown-${iteration}.json`), JSON.stringify(result, null, 2))
      }
      summary.results.push(result)
      if (!result.passed) throw new Error(result.failure)
      ++summary.completed
      save()
      console.log(JSON.stringify({ point, completed: summary.completed, required: count, elapsedMs: result.elapsedMs }))
    }
    summary.passed = true
  } catch (error) {
    summary.failure = failureCode(error)
  } finally { save() }
  return summary
}
