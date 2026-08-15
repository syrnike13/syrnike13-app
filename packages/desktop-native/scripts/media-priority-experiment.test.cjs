const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  analyzeEtwProviderCoverage,
  buildContentionRunnerArguments,
  createWprRecordingGuard,
  extractPriorityOutcome,
  parseExperimentOptions,
  runPriorityMatrix,
  selectLowestPassingPriority,
} = require('./media-priority-experiment.cjs')

test('owned WPR recording is cancelled once before signal termination', async () => {
  const processHost = new EventEmitter()
  processHost.pid = 42
  const commands = []
  const terminated = []
  const guard = createWprRecordingGuard({
    processHost,
    terminate: (signal) => terminated.push(signal),
    wprExecutable: 'wpr.exe',
    runProcess: async (executable, args) => {
      commands.push([executable, ...args])
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  guard.markStarted()

  processHost.emit('SIGTERM')
  await guard.cancel()
  await new Promise((resolve) => setImmediate(resolve))
  await guard.cancel()

  assert.deepEqual(commands, [['wpr.exe', '-cancel']])
  assert.deepEqual(terminated, ['SIGTERM'])
  guard.dispose()
})

test('failed WPR start never cancels an unrelated machine-wide session', async () => {
  const processHost = new EventEmitter()
  processHost.pid = 42
  const commands = []
  const terminated = []
  const guard = createWprRecordingGuard({
    processHost,
    terminate: (signal) => terminated.push(signal),
    wprExecutable: 'wpr.exe',
    runProcess: async (executable, args) => {
      commands.push([executable, ...args])
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  guard.trackStart(Promise.resolve({ code: 1 }))

  processHost.emit('SIGINT')
  await guard.cancel()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(commands, [])
  assert.deepEqual(terminated, ['SIGINT'])
  guard.dispose()
})

test('priority experiment forwards the local LiveKit server into contention', () => {
  const parsed = parseExperimentOptions([
    '--profile', 'ci',
    '--build-dir', 'E:\\build\\Release',
    '--livekit-server', 'E:\\tools\\livekit-server.exe',
    '--audio-policy-result', 'E:\\audio-policy.json',
    '--contention-output-dir', 'E:\\out\\contention',
  ])
  const args = buildContentionRunnerArguments('normal', parsed)
  const liveKitIndex = args.indexOf('--livekit-server')
  assert.notEqual(liveKitIndex, -1)
  assert.equal(
    path.resolve(args[liveKitIndex + 1]),
    path.resolve('E:\\tools\\livekit-server.exe'),
  )
})

test('ETW provider analysis covers every required media contention domain', () => {
  const details = `
    Actual Trace Duration (ms): 12500
    NT Kernel Logger,CSwitch,Count=1200
    NT Kernel Logger,ReadyThread,Count=900
    Microsoft-Windows-DxgKrnl,QueuePacket,Count=400
    Microsoft-Windows-Dwm-Core,Present,Count=300
    Microsoft-Windows-DirectComposition,Commit,Count=220
    Microsoft-Windows-Win32k,CompositionSurface,Count=180
    MediaFoundation,HardwareEncoderMFT,Count=150
    AudioEngine,RenderWakeup,Count=800
  `

  assert.deepEqual(analyzeEtwProviderCoverage(details), {
    coverage: completeEtwCoverage(),
    traceDurationMs: 12_500,
  })
})

test('ETW provider analysis accepts bounded real xperf tracestats format', () => {
  const details = readFileSync(
    path.join(
      __dirname,
      'fixtures',
      'media-priority-xperf-tracestats.txt',
    ),
    'utf8',
  )

  assert.deepEqual(analyzeEtwProviderCoverage(details), {
    coverage: completeEtwCoverage(),
    traceDurationMs: 12_500,
  })
})

test('ETW provider names, zero counts and generic DX events are not evidence', () => {
  const namesOnly = `
    Actual Trace Duration (ms): 0
    CSwitch ReadyThread Microsoft-Windows-DxgKrnl
    Microsoft-Windows-Dwm-Core Microsoft-Windows-DirectComposition
    Microsoft-Windows-Win32k DX AudioEngine
  `
  const zeroCounts = namesOnly.replace(
    'CSwitch ReadyThread Microsoft-Windows-DxgKrnl',
    'NT Kernel Logger,CSwitch,Count=0\n' +
      'NT Kernel Logger,ReadyThread,Count=0\n' +
      'Microsoft-Windows-DxgKrnl,QueuePacket,Count=0',
  ) + '\nDX,EncodeFrame,Count=999'

  assert.deepEqual(analyzeEtwProviderCoverage(namesOnly), {
    coverage: emptyEtwCoverage(),
    traceDurationMs: null,
  })
  assert.equal(analyzeEtwProviderCoverage(zeroCounts).coverage.encoder, false)

  const providerTotalOnly = `
    Crimson ProviderId                                      TotalCount
    ======================================                  ==========
    {A1BC18C0-A7C8-11D1-BF3C-00A0C9062910}                        999
        MediaFoundation
  `
  assert.equal(
    analyzeEtwProviderCoverage(providerTotalOnly).coverage.encoder,
    false,
  )

  const zeroEventCount = readFileSync(
    path.join(
      __dirname,
      'fixtures',
      'media-priority-xperf-tracestats.txt',
    ),
    'utf8',
  ).replace(
    /0x002c 0x0007 0x00\s+0x00\s+0x00\s+0x00\s+0x0000000000000000\s+150\s+12000/,
    '0x002c 0x0007 0x00   0x00    0x00    0x00  ' +
      '0x0000000000000000            0           12000',
  )
  assert.equal(
    analyzeEtwProviderCoverage(zeroEventCount).coverage.encoder,
    false,
  )
})

test('ETW machine tables use their Count column and actual time range', () => {
  const details = `
    "Actual Start Time","Actual End Time"
    "2026-08-15T00:00:00.000Z","2026-08-15T00:00:12.500Z"
    "Provider","Task","Count"
    "NT Kernel Logger","CSwitch",1200
    "NT Kernel Logger","ReadyThread",900
    "Microsoft-Windows-DxgKrnl","QueuePacket",400
    "Microsoft-Windows-Dwm-Core","Present",300
    "Microsoft-Windows-DirectComposition","Commit",220
    "Microsoft-Windows-Win32k","CompositionSurface",180
    "MediaFoundation","HardwareEncoderMFT",150
    "AudioEngine","RenderWakeup",800
  `

  assert.deepEqual(analyzeEtwProviderCoverage(details), {
    coverage: completeEtwCoverage(),
    traceDurationMs: 12_500,
  })
})

test('priority diagnostics require thread and both D3D roles', () => {
  const records = [
    {
      event: 'screen_capture_priority',
      policy: 'capture',
      threadRequested: 0,
      threadApplied: 0,
      threadSucceeded: true,
      threadWin32Error: 0,
      mmcssRequested: true,
      mmcssRegistered: true,
      mmcssWin32Error: 0,
    },
    {
      event: 'screen_d3d_priority',
      policy: 'capture',
      role: 'publication',
      requested: 1,
      applied: 1,
      hresult: 0,
    },
    {
      event: 'screen_d3d_priority',
      policy: 'capture',
      role: 'preview',
      requested: 0,
      applied: 0,
      hresult: 0,
    },
  ]

  assert.deepEqual(extractPriorityOutcome(records, 'capture'), {
    policy: 'capture',
    captureThread: {
      requested: 0,
      applied: 0,
      succeeded: true,
      win32Error: 0,
    },
    captureMmcss: {
      requested: true,
      registered: true,
      win32Error: 0,
    },
    publicationD3d: {
      requested: 1,
      applied: 1,
      hresult: 0,
    },
    previewD3d: {
      requested: 0,
      applied: 0,
      hresult: 0,
    },
  })
  assert.equal(extractPriorityOutcome(records.slice(0, 2), 'capture'), null)
})

test('policy selection fails closed without ETW scheduling evidence', () => {
  const selection = selectLowestPassingPriority([
    passingObservation('normal', { captured: false, reason: 'WPR denied' }),
    passingObservation('capture', { captured: true }),
    passingObservation('legacy-high', { captured: true }),
  ])

  assert.equal(selection.status, 'blocked')
  assert.equal(selection.selectedPolicy, null)
  assert.match(selection.blockers.join('\n'), /normal.*ETW/i)
})

test('policy selection blocks when ETW is missing a required evidence domain', () => {
  const observations = [
    passingObservation('normal', {
      captured: true,
      coverage: {
        ...completeEtwCoverage(),
        audioWakeups: false,
      },
    }),
    passingObservation('capture', {
      captured: true,
      coverage: completeEtwCoverage(),
    }),
    passingObservation('legacy-high', {
      captured: true,
      coverage: completeEtwCoverage(),
    }),
  ]

  const selection = selectLowestPassingPriority(observations)

  assert.equal(selection.status, 'blocked')
  assert.equal(selection.selectedPolicy, null)
  assert.match(selection.blockers.join('\n'), /normal.*audio wakeups/i)
})

test('policy selection blocks an ETW trace shorter than the contention run', () => {
  const short = passingObservation('normal', {
    captured: true,
    coverage: completeEtwCoverage(),
    traceDurationMs: 1_000,
  })

  const selection = selectLowestPassingPriority([
    short,
    passingObservation('capture', { captured: true }),
    passingObservation('legacy-high', { captured: true }),
  ])

  assert.equal(selection.status, 'blocked')
  assert.match(selection.blockers.join('\n'), /normal.*trace duration/i)
})

test('selection chooses the lowest policy meeting media and competitor bounds', () => {
  const normal = passingObservation('normal', { captured: true })
  normal.contention.result.failures = ['local playout scheduled age exceeded']
  const capture = passingObservation('capture', { captured: true })
  const elevated = passingObservation('legacy-high', { captured: true })
  elevated.contention.result.metrics.competingWorkloadP99Ms = 48

  const selection = selectLowestPassingPriority([normal, capture, elevated])

  assert.equal(selection.status, 'pass')
  assert.equal(selection.selectedPolicy, 'capture')
})

test('selection rejects a contention result with an unknown blocker', () => {
  const normal = passingObservation('normal', { captured: true })
  normal.contention.result.status = 'blocked'
  normal.contention.result.blockers = ['screenCapture: unavailable']
  normal.contention.result.blockerDetails = [{
    code: 'required_capability_unavailable',
    message: 'screenCapture: unavailable',
  }]

  const selection = selectLowestPassingPriority([
    normal,
    passingObservation('capture', { captured: true }),
    passingObservation('legacy-high', { captured: true }),
  ])

  assert.equal(selection.status, 'pass')
  assert.equal(selection.selectedPolicy, 'capture')
})

test('selection allows only the typed absent Bluetooth endpoint blocker', () => {
  const normal = passingObservation('normal', { captured: true })
  normal.contention.result.status = 'blocked'
  normal.contention.result.blockers = [
    'Bluetooth audio-policy matrix: no active endpoint pair',
  ]
  normal.contention.result.blockerDetails = [{
    code: 'bluetooth_endpoint_pair_absent',
    message: normal.contention.result.blockers[0],
  }]

  const selection = selectLowestPassingPriority([
    normal,
    passingObservation('capture', { captured: true }),
    passingObservation('legacy-high', { captured: true }),
  ])

  assert.equal(selection.status, 'pass')
  assert.equal(selection.selectedPolicy, 'normal')
})

test('matrix still records every real policy run when WPR is privilege-blocked', async () => {
  const contentionRuns = []
  const result = await runPriorityMatrix(
    { profile: 'ci', writeResult: false },
    {
      captureEtw: async (policy, runContention) => ({
        etw: {
          captured: false,
          reason: 'WPR start failed: profile-system-performance denied',
        },
        contention: await runContention(),
      }),
      runContention: async (policy) => {
        contentionRuns.push(policy)
        return passingObservation(policy, { captured: true }).contention
      },
    },
  )

  assert.deepEqual(contentionRuns, ['normal', 'capture', 'legacy-high'])
  assert.equal(result.selection.status, 'blocked')
  assert.equal(result.observations.length, 3)
})

function passingObservation(policy, etw) {
  return {
    policy,
    etw: {
      ...etw,
      ...(etw.captured === true && etw.coverage === undefined
        ? { coverage: completeEtwCoverage(), traceDurationMs: 12_500 }
        : {}),
    },
    contention: {
      profile: { name: 'ci', durationMs: 12_000 },
      result: {
        status: 'pass',
        blockers: [],
        failures: [],
        metrics: {
          uiEventLoopP95Ms: 10,
          uiEventLoopP99Ms: 20,
          normalVideoFrameAgeP99Ms: 80,
          localPlayoutScheduledAgeMaxMs: 40,
          competingWorkloadFps: 58,
          competingWorkloadP95Ms: 18,
          competingWorkloadP99Ms: 28,
        },
      },
    },
  }
}

function completeEtwCoverage() {
  return {
    scheduling: true,
    gpuQueue: true,
    dwm: true,
    renderer: true,
    capture: true,
    encoder: true,
    audioWakeups: true,
  }
}

function emptyEtwCoverage() {
  return Object.fromEntries(
    Object.keys(completeEtwCoverage()).map((field) => [field, false]),
  )
}
