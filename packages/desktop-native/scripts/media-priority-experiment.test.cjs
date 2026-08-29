const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  analyzeEtwProviderCoverage,
  buildContentionRunnerArguments,
  buildWprStartArguments,
  createWprRecordingGuard,
  extractPriorityOutcome,
  parseExperimentOptions,
  preparePriorityLiveKitOptions,
  requiredEtwDurationMs,
  resolveTraceDirectory,
  runPriorityMatrix,
  selectLowestPassingPriority,
  startWprRecording,
  waitForPath,
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

test('WPR start cancels a stale session that status does not report', async () => {
  const commands = []
  let starts = 0
  const runProcess = async (_executable, args) => {
    commands.push([...args])
    if (args[0] === '-cancel') {
      return { code: 1, stdout: '', stderr: '    WPR is not recording\r\n' }
    }
    if (args[0] === '-start') {
      starts += 1
      if (starts === 1) {
        return {
          code: 3310891009,
          stdout: '',
          stderr: '\tThe profiles are already running.\r\n\tError code: 0xc5583001\r\n',
        }
      }
      return { code: 0, stdout: '    The trace was successfully started.\r\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }

  const { start, recording } = await startWprRecording('wpr.exe', 'G:\\traces', {
    runProcess,
    settleMs: 0,
  })
  recording.dispose()

  assert.equal(start.code, 0)
  assert.equal(starts, 2)
  assert.deepEqual(
    commands.filter((args) => args[0] === '-cancel'),
    [['-cancel'], ['-cancel']],
  )
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

test('priority experiment mints LiveKit tokens before forwarding them into contention', async () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'media-priority-livekit-'))
  try {
    const prepared = await preparePriorityLiveKitOptions(
      'capture',
      {
        liveKitServer: 'E:\\tools\\livekit-server.exe',
        outputDirectory,
      },
      {
        mintLocalLiveKitSession: async () => ({
          roomName: 'issue83-test',
          participants: Array.from({ length: 16 }, (_, index) => ({
            publisherIdentity: `contention-publisher-${index + 1}`,
            publisherToken: `pub-${index + 1}`,
            viewerIdentity: `contention-viewer-${index + 1}`,
            viewerToken: `view-${index + 1}`,
          })),
        }),
      },
    )

    assert.equal(prepared.liveKitRoom, 'issue83-test')
    assert.equal(
      path.basename(prepared.liveKitParticipantsFile),
      'livekit-participants-capture.json',
    )
    const stored = JSON.parse(readFileSync(prepared.liveKitParticipantsFile, 'utf8'))
    assert.equal(stored.roomName, 'issue83-test')
    assert.equal(stored.participants.length, 16)

    const args = buildContentionRunnerArguments('capture', prepared)
    assert.equal(args[args.indexOf('--livekit-room') + 1], 'issue83-test')
    assert.equal(
      path.resolve(args[args.indexOf('--livekit-participants-file') + 1]),
      path.resolve(prepared.liveKitParticipantsFile),
    )
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})

test('priority experiment forwards a contention-started file so ETW arms after first frame', () => {
  const args = buildContentionRunnerArguments('normal', {
    profile: 'ci',
    buildDirectory: 'E:\\build\\Release',
    contentionStartedFile: 'G:\\traces\\contention-started-normal.flag',
  })
  const index = args.indexOf('--contention-started-file')
  assert.notEqual(index, -1)
  assert.equal(
    path.resolve(args[index + 1]),
    path.resolve('G:\\traces\\contention-started-normal.flag'),
  )
})

test('waitForPath resolves once the contention-started flag appears', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'media-priority-started-'))
  const flag = path.join(directory, 'started.flag')
  try {
    const pending = waitForPath(flag, 1_000, { pollMs: 20 })
    await new Promise((resolve) => setTimeout(resolve, 40))
    writeFileSync(flag, '1\n')
    assert.equal(await pending, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
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

test('ETW provider analysis accepts WPT inline Count TotalSize Name rows', () => {
  const details = readFileSync(
    path.join(
      __dirname,
      'fixtures',
      'media-priority-xperf-tracestats-wpt.txt',
    ),
    'utf8',
  )

  assert.deepEqual(analyzeEtwProviderCoverage(details), {
    coverage: completeEtwCoverage(),
    traceDurationMs: 12_500,
  })
})

test('ETW audio coverage accepts Windows 11 Audio.light stream state after first frame', () => {
  const details = `
    First event          : 2026/08/17:12:22:27.9000
    Last event           : 2026/08/17:12:22:59.9000
    TraceLogging ProviderId                       TotalCount       TotalSize  Name
    {3d2b6366-47a4-5e10-6974-e5f7de0d3f28}                 8            3562  Microsoft.Windows.Audio.Service
        Opcode Channel Level Keyword                   Count       TotalSize  Name
        0x00   0x0b    0x04  0x0000000000000004            4            2794  AudioSrvStreamState
  `
  assert.equal(analyzeEtwProviderCoverage(details).coverage.audioWakeups, true)
})

test('ETW audio coverage accepts Windows 11 Audio.light stream starts', () => {
  const details = `
    First event          : 2026/08/15:02:48:55.1000
    Last event           : 2026/08/15:02:49:07.6000
    Id     Task   Opcode Version Channel Level Keyword                   Count       TotalSize  Name
    0x00   0x0b    0x04  0x0000000000000200            4            2052  StreamStarted
  `
  assert.equal(analyzeEtwProviderCoverage(details).coverage.audioWakeups, false)

  const withProvider = details.replace(
    'StreamStarted',
    'Microsoft.Windows.Audio.Service/StreamStarted',
  )
  assert.equal(
    analyzeEtwProviderCoverage(withProvider).coverage.audioWakeups,
    true,
  )
})

test('WPR recording and ETL land on a local trace directory, not Nextcloud', () => {
  const parsed = parseExperimentOptions([
    '--profile', 'ci',
    '--output-dir', 'E:\\Nextcloud\\Files\\Code\\repo\\artifacts',
    '--trace-dir', 'G:\\syrnike13-build-cache\\media-priority-etw',
  ])
  assert.equal(
    resolveTraceDirectory(parsed),
    path.resolve('G:\\syrnike13-build-cache\\media-priority-etw'),
  )
  assert.deepEqual(
    buildWprStartArguments(parsed.traceDirectory),
    [
      '-start', 'CPU.light',
      '-start', 'GPU.light',
      '-start', 'DesktopComposition.light',
      '-start', 'Audio.light',
      '-start', 'Video.light',
      '-start',
      path.join(__dirname, 'media-priority-mf.wprp') + '!MF.light',
      '-filemode',
      '-recordtempto',
      path.resolve('G:\\syrnike13-build-cache\\media-priority-etw'),
    ],
  )
})

test('ETW encoder coverage accepts Windows 11 MediaFoundation-Performance MFT output', () => {
  const details = `
    First event          : 2026/08/15:02:48:55.1000
    Last event           : 2026/08/15:02:49:07.6000
    {F404B94E-27E0-4384-BFE8-1D8D390B0AA3}        80            4000  Microsoft-Windows-MediaFoundation-Performance
    Id     Task   Opcode Version Channel Level Keyword                   Count       TotalSize  Name
    0x0fb4 0x013b 0x0b   0x00    0x10    0x05  0x8000000000000000         7635          313035  Microsoft-Windows-MediaFoundation-Performance/Process/op_mfperf_Output
  `
  assert.equal(analyzeEtwProviderCoverage(details).coverage.encoder, true)
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

test('priority diagnostics reject a sidecar capture that hides the probe policy', () => {
  const records = [
    {
      event: 'screen_capture_priority',
      policy: 'normal',
      threadRequested: 0,
      threadApplied: 0,
      threadSucceeded: true,
      threadWin32Error: 0,
      mmcssRequested: false,
      mmcssRegistered: false,
      mmcssWin32Error: 0,
    },
    {
      event: 'screen_d3d_priority',
      policy: 'normal',
      role: 'publication',
      requested: 0,
      applied: 0,
      hresult: 0,
    },
    {
      event: 'screen_d3d_priority',
      policy: 'normal',
      role: 'preview',
      requested: 0,
      applied: 0,
      hresult: 0,
    },
    {
      event: 'screen_capture_priority',
      policy: 'legacy-high',
      threadRequested: 2,
      threadApplied: 2,
      threadSucceeded: true,
      threadWin32Error: 0,
      mmcssRequested: true,
      mmcssRegistered: true,
      mmcssWin32Error: 0,
    },
  ]

  assert.equal(extractPriorityOutcome(records, 'normal'), null)
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

test('policy selection blocks an ETW trace shorter than the recording budget', () => {
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

test('production ETW evidence is a bounded window, not 90% of the 600s soak', () => {
  const observation = passingObservation('normal', {
    captured: true,
    coverage: completeEtwCoverage(),
    traceDurationMs: 30_000,
  })
  observation.contention.profile = { name: 'production', durationMs: 600_000 }

  assert.equal(requiredEtwDurationMs(observation), 10_800)

  const tooShort = passingObservation('normal', {
    captured: true,
    coverage: completeEtwCoverage(),
    traceDurationMs: 8_000,
  })
  tooShort.contention.profile = { name: 'production', durationMs: 600_000 }
  const blocked = selectLowestPassingPriority([
    tooShort,
    passingObservation('capture', { captured: true }),
    passingObservation('legacy-high', { captured: true }),
  ])
  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.blockers.join('\n'), /normal.*trace duration/i)

  const complete = selectLowestPassingPriority([
    observation,
    passingObservation('capture', { captured: true }),
    passingObservation('legacy-high', { captured: true }),
  ])
  assert.equal(complete.status, 'pass')
  assert.equal(complete.selectedPolicy, 'normal')
})

test('confirmation matrix can evaluate a single selected policy', async () => {
  const result = await runPriorityMatrix(
    { profile: 'ci', onlyPolicy: 'normal', writeResult: false },
    {
      captureEtw: async (policy, runContention) => ({
        etw: {
          captured: true,
          coverage: completeEtwCoverage(),
          traceDurationMs: 12_500,
        },
        contention: await runContention(),
      }),
      runContention: async (policy) =>
        passingObservation(policy, { captured: true }).contention,
    },
  )

  assert.deepEqual(result.observations.map((item) => item.policy), ['normal'])
  assert.equal(result.selection.status, 'pass')
  assert.equal(result.selection.selectedPolicy, 'normal')
})

test('priority experiment parses a single-policy confirmation run', () => {
  const parsed = parseExperimentOptions([
    '--profile',
    'production',
    '--only-policy',
    'normal',
    '--build-dir',
    'E:\\build\\Release',
  ])
  assert.equal(parsed.profile, 'production')
  assert.equal(parsed.onlyPolicy, 'normal')
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

test('matrix still records later policies when one contention run throws', async () => {
  const contentionRuns = []
  const result = await runPriorityMatrix(
    { profile: 'ci', writeResult: false },
    {
      captureEtw: async (policy, runContention) => {
        try {
          return {
            etw: {
              captured: true,
              coverage: completeEtwCoverage(),
              traceDurationMs: 12_500,
            },
            contention: await runContention(),
          }
        } catch (error) {
          return {
            etw: {
              captured: true,
              coverage: completeEtwCoverage(),
              traceDurationMs: 12_500,
            },
            contention: {
              profile: { name: 'ci', durationMs: 12_000 },
              result: {
                status: 'failed',
                blockers: [],
                failures: [error.message],
                metrics: {},
              },
            },
          }
        }
      },
      runContention: async (policy) => {
        contentionRuns.push(policy)
        if (policy === 'legacy-high') {
          throw new Error(
            'linked Room video did not reach exact Electron presentation before contention',
          )
        }
        return passingObservation(policy, { captured: true }).contention
      },
    },
  )

  assert.deepEqual(contentionRuns, ['normal', 'capture', 'legacy-high'])
  assert.equal(result.observations.length, 3)
  assert.equal(result.selection.status, 'pass')
  assert.equal(result.selection.selectedPolicy, 'normal')
})

test('matrix still records later policies when captureEtw throws', async () => {
  const result = await runPriorityMatrix(
    { profile: 'ci', writeResult: false },
    {
      captureEtw: async (policy, runContention) => {
        if (policy === 'capture') throw new Error('WPR stop exploded')
        return {
          etw: {
            captured: true,
            coverage: completeEtwCoverage(),
            traceDurationMs: 12_500,
          },
          contention: await runContention(),
        }
      },
      runContention: async (policy) =>
        passingObservation(policy, { captured: true }).contention,
    },
  )

  assert.equal(result.observations.length, 3)
  assert.equal(result.observations[1].etw.captured, false)
  assert.equal(result.selection.status, 'blocked')
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
