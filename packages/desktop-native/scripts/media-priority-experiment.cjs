const { execFileSync, spawn } = require('node:child_process')
const { appendFileSync, createWriteStream, existsSync } = require('node:fs')
const {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} = require('node:fs/promises')
const path = require('node:path')
const { gunzipSync } = require('node:zlib')

const PRIORITY_POLICY_ORDER = ['normal', 'capture', 'legacy-high']
const REQUIRED_ETW_COVERAGE = [
  ['scheduling', 'scheduling'],
  ['gpuQueue', 'GPU queue'],
  ['dwm', 'DWM'],
  ['renderer', 'renderer'],
  ['capture', 'capture'],
  ['encoder', 'encoder'],
  ['audioWakeups', 'audio wakeups'],
]
const MAXIMUM_TRACE_BYTES = 512 * 1024 * 1024
const ETW_RECORDING_BUDGET_MS = 22_000
const ETW_REQUIRED_WINDOW_MS = 12_000
const CLOUD_SYNC_PATH =
  /(?:^|[\\/])(?:Nextcloud|OneDrive|Dropbox)(?:[\\/]|$)/i
const LOCAL_TRACE_CACHE = 'G:\\syrnike13-build-cache\\media-priority-etw'
const WPR_BUILTIN_PROFILES = [
  'CPU.light',
  'GPU.light',
  'DesktopComposition.light',
  'Audio.light',
  'Video.light',
]

function readSourceProvenance() {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..')
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
  const relevantChanges = execFileSync(
    'git',
    [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      'apps/desktop',
      'packages/desktop-native',
      'packages/platform',
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).trim()
  return {
    commitSha,
    relevantWorkingTreeDirty: relevantChanges.length > 0,
  }
}

const {
  PRIORITY_COMPETING_LIMITS: COMPETING_LIMITS,
  linkedVideoReadyDeadlineMs,
  resolveContentionProfile,
} = require('./media-contention-profile.cjs')
const {
  mintLocalLiveKitSession,
} = require('./media-contention-livekit.cjs')

function extractPriorityOutcome(records, policy) {
  const conflicting = records.some(
    (record) =>
      (record?.event === 'screen_capture_priority' ||
        record?.event === 'screen_d3d_priority') &&
      record?.policy &&
      record.policy !== policy,
  )
  if (conflicting) return null
  const latest = (event, role) =>
    records
      .filter(
        (record) =>
          record?.event === event &&
          record?.policy === policy &&
          (role === undefined || record?.role === role),
      )
      .at(-1)
  const thread = latest('screen_capture_priority')
  const publication = latest('screen_d3d_priority', 'publication')
  const preview = latest('screen_d3d_priority', 'preview')
  if (!thread || !publication || !preview) return null
  return {
    policy,
    captureThread: {
      requested: thread.threadRequested,
      applied: thread.threadApplied,
      succeeded: thread.threadSucceeded,
      win32Error: thread.threadWin32Error,
    },
    captureMmcss: {
      requested: thread.mmcssRequested,
      registered: thread.mmcssRegistered,
      win32Error: thread.mmcssWin32Error,
    },
    publicationD3d: {
      requested: publication.requested,
      applied: publication.applied,
      hresult: publication.hresult,
    },
    previewD3d: {
      requested: preview.requested,
      applied: preview.applied,
      hresult: preview.hresult,
    },
  }
}

function analyzeEtwProviderCoverage(providerDetails) {
  const details = String(providerDetails ?? '')
  const lines = details.split(/\r?\n/)
  const countedRecords = extractCountedEtwRecords(lines)
  const counted = (...patterns) => countedRecords.some(({ text }) =>
    patterns.every((pattern) => pattern.test(text)),
  )
  const traceDurationMs = extractTraceDurationMs(lines)
  return {
    coverage: {
      scheduling: counted(/\bCSwitch\b/i) && counted(/\bReadyThread\b/i),
      gpuQueue: counted(
        /Microsoft-Windows-DxgKrnl/i,
        /Queue|Packet|DMA|Submit|Present/i,
      ),
      dwm: counted(/Microsoft-Windows-Dwm-Core/i),
      renderer: counted(/Microsoft-Windows-DirectComposition/i),
      capture: counted(/Microsoft-Windows-Win32k/i),
      encoder: counted(
        /MediaFoundation|DXVA2/i,
        /Encod|\bMFT\b|Transform|Process(?:Input|Output)|HaveOutput|NeedInput|op_mfperf_(?:Input|Output)/i,
      ),
      audioWakeups:
        counted(/\bAudioEngine\b/i) ||
        counted(
          /Microsoft\.Windows\.Audio\.(?:Service|Client)\b/i,
          /StreamStarted|RenderWakeup|FirstPacket|AudioClientStart|IAudioClient::Start|AudioSrvStreamState/i,
        ),
    },
    traceDurationMs,
  }
}

function extractCountedEtwRecords(lines) {
  const records = []
  let table = null
  let current = null
  let currentProvider = ''
  let awaitingProviderName = false
  const flush = () => {
    if (current?.count > 0) {
      records.push({ count: current.count, text: current.lines.join(' ') })
    }
    current = null
  }

  for (const line of lines) {
    const summary = parseEtwProviderSummaryRow(line)
    if (summary) {
      flush()
      table = null
      currentProvider = summary.name
      awaitingProviderName = summary.name === ''
      continue
    }

    const header = detectEtwCountTable(line)
    if (header) {
      flush()
      table = header
      awaitingProviderName = false
      continue
    }

    const friendlyName = line.match(
      /^\s*(Provider|Task|Opcode|Event)(?:\s+Friendly)?\s+Name\s*[:=]\s*(.+?)\s*$/i,
    )
    if (friendlyName) {
      if (/^Provider$/i.test(friendlyName[1])) {
        currentProvider = friendlyName[2]
      }
      if (current) current.lines.push(friendlyName[2], line)
      continue
    }

    if (awaitingProviderName && isEtwFriendlyNameRow(line)) {
      currentProvider = line.trim()
      awaitingProviderName = false
      continue
    }

    const namedRow = extractInlineNamedCountRow(line)
    if (namedRow) {
      flush()
      current = {
        count: namedRow.count,
        lines: currentProvider
          ? [currentProvider, namedRow.name, line]
          : [namedRow.name, line],
      }
      flush()
      continue
    }

    const explicit = line.match(/\b(?:Count|Events?)\s*[=:]\s*(\d+)\b/i)
    const tableCount = table ? extractEtwTableCount(line, table) : Number.NaN
    const count = explicit ? Number(explicit[1]) : tableCount
    if (Number.isFinite(count)) {
      flush()
      current = {
        count,
        lines: currentProvider ? [currentProvider, line] : [line],
      }
      continue
    }

    if (current && isEtwFriendlyNameRow(line)) {
      current.lines.push(line.trim())
    }
  }
  flush()
  return records
}

function parseEtwProviderSummaryRow(line) {
  const match = String(line).match(
    /^\s*\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}\s+\d+(?:\s+\d+)*(?:\s+(\S.*\S))?\s*$/i,
  )
  if (!match) return null
  return { name: match[1] ? match[1].trim() : '' }
}

function extractInlineNamedCountRow(line) {
  const match = String(line).match(
    /^\s*(?:0x[0-9a-f]+\s+)+\s*(\d+)\s+(\d+)\s+(\S.*\S)\s*$/i,
  )
  if (!match) return null
  if (/^[-=.|]+$/.test(match[3])) return null
  return { count: Number(match[1]), name: match[3].trim() }
}

function isEtwFriendlyNameRow(line) {
  const value = String(line)
  const trimmed = value.trim()
  return (
    /^\s+/.test(value) &&
    /[a-z]/i.test(trimmed) &&
    !/^(?:Id|Type|Name)\b/i.test(trimmed) &&
    !/^[-=\s]+$/.test(trimmed)
  )
}

function detectEtwCountTable(line) {
  const csvFields = parseDelimitedFields(line)
  const csvIndex = csvFields.findIndex((field) =>
    /^(?:Event\s+)?Count$/i.test(field),
  )
  if (csvFields.length > 1 && csvIndex >= 0) {
    return { delimiter: 'csv', countIndex: csvIndex }
  }

  const value = String(line)
  const count = /\bCount\b/i.exec(value)
  if (count && !/\d/.test(value)) {
    const suffix = value.slice(count.index + count[0].length)
    return {
      delimiter: 'whitespace',
      countAtEnd: !/\bTotalSize\b/i.test(suffix),
      countWithTotalSize: /\bTotalSize\b/i.test(suffix),
    }
  }
  return null
}

function extractEtwTableCount(line, table) {
  if (!String(line).trim()) return Number.NaN
  if (table.countWithTotalSize) {
    const trailing = String(line).match(/\s(\d+)\s+(\d+)\s*$/)
    return trailing ? Number(trailing[1]) : Number.NaN
  }
  if (table.countAtEnd) {
    const trailing = String(line).match(/\s(\d+)\s*$/)
    if (trailing) return Number(trailing[1])
  }
  const fields = table.delimiter === 'csv'
    ? parseDelimitedFields(line)
    : String(line).trim().split(/\t+|\s{2,}/)
  const value = Number(fields[table.countIndex])
  if (Number.isFinite(value)) return value
  return Number.NaN
}

function extractTraceDurationMs(lines) {
  for (const line of lines) {
    const match = line.match(
      /Actual(?:\s+Trace)?\s+Duration(?:\s*\((ms|s|us)\))?\s*[:=,]\s*(\d+(?:\.\d+)?)\s*(ms|s|us)?/i,
    )
    if (!match) continue
    const value = Number(match[2])
    const unit = (match[1] || match[3] || 'ms').toLowerCase()
    const milliseconds = unit === 's' ? value * 1_000
      : unit === 'us' ? value / 1_000
        : value
    return milliseconds > 0 ? milliseconds : null
  }
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const header = parseDelimitedFields(lines[index])
    const startIndex = header.findIndex((field) =>
      /Actual\s+(?:First|Start).*Time/i.test(field),
    )
    const endIndex = header.findIndex((field) =>
      /Actual\s+(?:Last|End).*Time/i.test(field),
    )
    if (startIndex < 0 || endIndex < 0) continue
    const values = parseDelimitedFields(lines[index + 1])
    const start = Date.parse(values[startIndex])
    const end = Date.parse(values[endIndex])
    const duration = end - start
    if (Number.isFinite(duration) && duration > 0) return duration
  }
  const first = parseTraceTimestamp(
    lines,
    /(?:Actual\s+)?(?:First|Start)(?:\s+(?:Event|Time))?/i,
  )
  const last = parseTraceTimestamp(
    lines,
    /(?:Actual\s+)?(?:Last|End)(?:\s+(?:Event|Time))?/i,
  )
  const duration = last - first
  return Number.isFinite(duration) && duration > 0 ? duration : null
}

function parseDelimitedFields(line) {
  return String(line)
    .trim()
    .split(',')
    .map((field) => field.trim().replace(/^"|"$/g, '').replace(/""/g, '"'))
}

function parseTraceTimestamp(lines, label) {
  const line = lines.find((candidate) => label.test(candidate))
  if (!line) return Number.NaN
  const value = line.replace(/^.*?[:=,]\s*/, '').trim()
  const windowsTimestamp = value.match(
    /^(\d{4})\/(\d{2})\/(\d{2}):(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?/,
  )
  if (windowsTimestamp) {
    const [, year, month, day, hour, minute, second, fraction = ''] =
      windowsTimestamp
    const milliseconds = Number((fraction + '000').slice(0, 3))
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      milliseconds,
    ).getTime()
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : Number.NaN
}

function requiredEtwDurationMs(observation) {
  const soakMs = observation?.contention?.profile?.durationMs
  if (!Number.isFinite(soakMs) || soakMs <= 0) return Number.POSITIVE_INFINITY
  return Math.min(soakMs, ETW_RECORDING_BUDGET_MS, ETW_REQUIRED_WINDOW_MS) * 0.9
}

function matrixPolicies(options = {}) {
  if (!options.onlyPolicy) return [...PRIORITY_POLICY_ORDER]
  if (!PRIORITY_POLICY_ORDER.includes(options.onlyPolicy)) {
    throw new Error(`unknown media priority policy: ${options.onlyPolicy}`)
  }
  return [options.onlyPolicy]
}

function selectLowestPassingPriority(observations, options = {}) {
  const policies = options.policies ?? PRIORITY_POLICY_ORDER
  const byPolicy = new Map(
    observations.map((observation) => [observation.policy, observation]),
  )
  const blockers = []
  for (const policy of policies) {
    const observation = byPolicy.get(policy)
    if (!observation) {
      blockers.push(`${policy}: no priority observation was recorded`)
      continue
    }
    if (observation.etw?.captured !== true) {
      blockers.push(
        `${policy}: ETW evidence unavailable: ${
          observation.etw?.reason || 'capture did not complete'
        }`,
      )
      continue
    }
    for (const [field, label] of REQUIRED_ETW_COVERAGE) {
      if (observation.etw?.coverage?.[field] === true) continue
      blockers.push(`${policy}: ETW ${label} evidence is missing`)
    }
    const minimumDurationMs = requiredEtwDurationMs(observation)
    if (!Number.isFinite(observation.etw?.traceDurationMs) ||
        observation.etw.traceDurationMs < minimumDurationMs) {
      blockers.push(`${policy}: ETW trace duration is incomplete`)
    }
  }
  if (blockers.length > 0) {
    return { status: 'blocked', selectedPolicy: null, blockers }
  }

  for (const policy of policies) {
    const observation = byPolicy.get(policy)
    if (!priorityObservationPasses(observation)) continue
    return { status: 'pass', selectedPolicy: policy, blockers: [] }
  }
  return {
    status: 'failed',
    selectedPolicy: null,
    blockers: [],
  }
}

function priorityObservationPasses(observation) {
  const result = observation?.contention?.result
  const metrics = result?.metrics ?? {}
  const blockers = Array.isArray(result?.blockers) ? result.blockers : []
  const blockerDetails = Array.isArray(result?.blockerDetails)
    ? result.blockerDetails
    : []
  const statusPasses =
    (result?.status === 'pass' && blockers.length === 0) ||
    (result?.status === 'blocked' && blockers.length > 0 &&
      blockerDetails.length === blockers.length &&
      blockerDetails.every(
        (blocker) => blocker?.code === 'bluetooth_endpoint_pair_absent',
      ))
  return (
    statusPasses &&
    Array.isArray(result?.failures) &&
    result.failures.length === 0 &&
    Number.isFinite(metrics.competingWorkloadFps) &&
    metrics.competingWorkloadFps >= COMPETING_LIMITS.framesPerSecondMin &&
    Number.isFinite(metrics.competingWorkloadP95Ms) &&
    metrics.competingWorkloadP95Ms <= COMPETING_LIMITS.p95MsMax &&
    Number.isFinite(metrics.competingWorkloadP99Ms) &&
    metrics.competingWorkloadP99Ms <= COMPETING_LIMITS.p99MsMax
  )
}

async function runPriorityMatrix(options = {}, dependencies = {}) {
  const runContention = dependencies.runContention ?? defaultRunContention
  const captureEtw = dependencies.captureEtw ?? defaultCaptureEtw

  const observations = []
  const policies = matrixPolicies(options)
  for (const policy of policies) {
    try {
      const observation = await captureEtw(
        policy,
        (overrides = {}) => runContention(policy, { ...options, ...overrides }),
        options,
      )
      observations.push({ policy, ...observation })
    } catch (error) {
      observations.push({
        policy,
        etw: {
          captured: false,
          reason: error instanceof Error ? error.message : String(error),
        },
        contention: contentionFailure(
          error,
          resolveContentionProfile(options.profile ?? 'ci'),
        ),
      })
    }
  }
  return {
    schema: 'syrnike.native-media-priority-matrix',
    version: 1,
    profile: options.profile ?? 'ci',
    observations,
    selection: selectLowestPassingPriority(observations, { policies }),
  }
}

function buildContentionRunnerArguments(policy, options) {
  const profile = resolveContentionProfile(options.profile ?? 'ci')
  const runnerPath = path.join(__dirname, 'media-contention-runner.cjs')
  const outputDirectory = path.resolve(
    options.contentionOutputDirectory ??
      path.join(defaultExperimentDirectory(), 'contention'),
  )
  const arguments = [
    runnerPath,
    '--profile',
    profile.name,
    '--priority-policy',
    policy,
    '--output-dir',
    outputDirectory,
  ]
  if (options.buildDirectory) {
    arguments.push('--build-dir', path.resolve(options.buildDirectory))
  }
  if (options.audioPolicyResult) {
    arguments.push(
      '--audio-policy-result',
      path.resolve(options.audioPolicyResult),
    )
  }
  const liveKitServer =
    options.liveKitServer ?? process.env.SYRNIKE_CONTENTION_LIVEKIT_SERVER
  if (liveKitServer) {
    arguments.push('--livekit-server', path.resolve(liveKitServer))
  }
  if (options.liveKitRoom) {
    arguments.push('--livekit-room', options.liveKitRoom)
  }
  if (options.liveKitParticipantsFile) {
    arguments.push(
      '--livekit-participants-file',
      path.resolve(options.liveKitParticipantsFile),
    )
  }
  if (options.contentionStartedFile) {
    arguments.push(
      '--contention-started-file',
      path.resolve(options.contentionStartedFile),
    )
  }
  return arguments
}

async function defaultRunContention(policy, options) {
  const electronExecutable = options.electronExecutable ??
    resolveElectronExecutable()
  const profile = resolveContentionProfile(options.profile ?? 'ci')
  const arguments = buildContentionRunnerArguments(policy, options)
  const result = await runBoundedProcess(electronExecutable, arguments, {
    timeoutMs: profile.durationMs + linkedVideoReadyDeadlineMs(profile) + 90_000,
  })
  const summary = result.stdout
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .findLast((entry) => typeof entry.artifactPath === 'string')
  if (!summary) {
    throw new Error(
      `contention runner produced no artifact for ${policy}: ${boundedText(
        result.stderr || result.stdout,
      )}`,
    )
  }
  const artifactBytes = await readFile(summary.artifactPath)
  return JSON.parse(gunzipSync(artifactBytes).toString('utf8'))
}

function createWprRecordingGuard(options = {}) {
  const processHost = options.processHost ?? process
  const runProcess = options.runProcess ?? runBoundedProcess
  const wprExecutable = options.wprExecutable ??
    'C:\\Windows\\System32\\wpr.exe'
  const terminate = options.terminate ?? ((signal) => {
    processHost.kill(processHost.pid, signal)
  })
  let ownership = Promise.resolve(false)
  let owned = false
  let cancelPromise = null
  let disposed = false

  const markStarted = () => {
    owned = true
    ownership = Promise.resolve(true)
  }
  const trackStart = (startPromise) => {
    ownership = startPromise.then(
      (result) => {
        owned = result?.code === 0
        return owned
      },
      () => false,
    )
  }
  const markStopped = () => {
    owned = false
  }
  const cancel = async () => {
    await ownership
    if (cancelPromise) return cancelPromise
    if (!owned) return undefined
    owned = false
    cancelPromise = runProcess(
      wprExecutable,
      ['-cancel'],
      { timeoutMs: 15_000 },
    )
    return cancelPromise
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    processHost.removeListener('SIGINT', onSigint)
    processHost.removeListener('SIGTERM', onSigterm)
  }
  const onSignal = (signal) => {
    dispose()
    void cancel().finally(() => terminate(signal))
  }
  const onSigint = () => onSignal('SIGINT')
  const onSigterm = () => onSignal('SIGTERM')
  processHost.once('SIGINT', onSigint)
  processHost.once('SIGTERM', onSigterm)
  return { cancel, dispose, markStarted, markStopped, trackStart }
}

function wprStopArguments(tracePath, policy) {
  return [
    '-stop',
    tracePath,
    `Syrnike media priority ${policy}`,
    '-compress',
    '-skipPdbGen',
  ]
}

function scheduleIndependentWprStop(wpr, tracePath, policy, delayMs, options = {}) {
  const traceDirectory = path.dirname(tracePath)
  const logPath = path.join(traceDirectory, `wpr-stop-${policy}.log`)
  const maxBytes = Number.isSafeInteger(options.maxBytes)
    ? options.maxBytes
    : 400 * 1024 * 1024
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, 'media-priority-wpr-stop.cjs'),
      String(delayMs),
      String(maxBytes),
      traceDirectory,
      logPath,
      wpr,
      ...wprStopArguments(tracePath, policy),
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const forward = (chunk) => {
    try {
      appendFileSync(logPath, chunk)
    } catch {
      // The stopper also writes this log; losing a fragment is non-fatal.
    }
  }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)
  child.on('error', (error) => {
    forward(String(error instanceof Error ? error.stack : error))
  })
  return child
}

async function waitForPath(filePath, timeoutMs, options = {}) {
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0
    ? options.pollMs
    : 50
  if (existsSync(filePath)) return true
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    if (existsSync(filePath)) return true
  }
  return existsSync(filePath)
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child) {
      resolve({ alreadyGone: true })
      return
    }
    if (Number.isInteger(child.exitCode) || child.signalCode) {
      resolve({ code: child.exitCode, signal: child.signalCode })
      return
    }
    const onExit = (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      try {
        child.kill('SIGKILL')
      } catch {
        // The stopper may have exited between the timeout and kill.
      }
      resolve({ timedOut: true })
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function wprIsRecording(wpr, runProcess = runBoundedProcess) {
  const status = await runProcess(wpr, ['-status'], { timeoutMs: 15_000 })
  const text = `${status.stdout}\n${status.stderr}`
  if (/not recording/i.test(text)) return false
  return /recording|already running|0xc5583001/i.test(text)
}

async function finalizeWprStop(wpr, tracePath, policy, recording) {
  if (!await wprIsRecording(wpr)) {
    recording.markStopped()
    return {
      code: existsSync(tracePath) ? 0 : 1,
      stdout: '',
      stderr: existsSync(tracePath) ? '' : 'WPR stop produced no ETL',
    }
  }
  const stop = await runBoundedProcess(
    wpr,
    wprStopArguments(tracePath, policy),
    { timeoutMs: 120_000 },
  )
  if (stop.code === 0) recording.markStopped()
  return stop
}

async function forceWprIdle(wpr, runProcess = runBoundedProcess) {
  return runProcess(wpr, ['-cancel'], { timeoutMs: 15_000 })
}

async function settleWpr(settleMs) {
  if (!Number.isFinite(settleMs) || settleMs <= 0) return
  await new Promise((resolve) => setTimeout(resolve, settleMs))
}

async function startWprRecording(wpr, traceDirectory, options = {}) {
  const runProcess = options.runProcess ?? runBoundedProcess
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 1_000
  // `wpr -status` can report "not recording" while `-start` still returns
  // 0xc5583001 / "already running". Always cancel before starting.
  await forceWprIdle(wpr, runProcess)
  await settleWpr(settleMs)
  let recording = createWprRecordingGuard({ wprExecutable: wpr, runProcess })
  const startOnce = () => runProcess(
    wpr,
    buildWprStartArguments(traceDirectory),
    { timeoutMs: 30_000 },
  )
  let startPromise = startOnce()
  recording.trackStart(startPromise)
  let start = await startPromise
  const details = `${start.stderr || ''}\n${start.stdout || ''}`
  if (start.code !== 0 && /already running|0xc5583001/i.test(details)) {
    recording.dispose()
    await forceWprIdle(wpr, runProcess)
    await settleWpr(settleMs)
    recording = createWprRecordingGuard({ wprExecutable: wpr, runProcess })
    startPromise = startOnce()
    recording.trackStart(startPromise)
    start = await startPromise
  }
  return { start, recording }
}

async function preparePriorityLiveKitOptions(policy, options, dependencies = {}) {
  if (!options.liveKitServer) return options
  const mint = dependencies.mintLocalLiveKitSession ?? mintLocalLiveKitSession
  const runChild = dependencies.runChild ?? ((executable, args, timeoutMs) =>
    runBoundedProcess(executable, args, { timeoutMs }))
  const session = await mint(path.resolve(options.liveKitServer), { runChild })
  const outputDirectory = path.resolve(
    options.outputDirectory ?? defaultExperimentDirectory(),
  )
  await mkdir(outputDirectory, { recursive: true })
  const liveKitParticipantsFile = path.join(
    outputDirectory,
    `livekit-participants-${policy}.json`,
  )
  await writeFile(liveKitParticipantsFile, `${JSON.stringify(session)}\n`)
  return {
    ...options,
    liveKitRoom: session.roomName,
    liveKitParticipantsFile,
  }
}

async function defaultCaptureEtw(policy, runContention, options) {
  const outputDirectory = path.resolve(
    options.outputDirectory ?? defaultExperimentDirectory(),
  )
  const traceDirectory = resolveTraceDirectory(options)
  const contentionProfile = resolveContentionProfile(options.profile ?? 'ci')
  const contentionOptions = await preparePriorityLiveKitOptions(policy, options)
  await mkdir(outputDirectory, { recursive: true })
  await mkdir(traceDirectory, { recursive: true })
  const startedFile = path.join(
    traceDirectory,
    `contention-started-${policy}.flag`,
  )
  await rm(startedFile, { force: true })
  const contentionPromise = Promise.resolve(runContention({
    liveKitRoom: contentionOptions.liveKitRoom,
    liveKitParticipantsFile: contentionOptions.liveKitParticipantsFile,
    contentionStartedFile: startedFile,
  })).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  const readyMs = linkedVideoReadyDeadlineMs(contentionProfile) + 15_000
  const started = await waitForPath(startedFile, readyMs)
  if (!started) {
    const settled = await contentionPromise
    return {
      etw: {
        captured: false,
        reason: 'contention did not reach the observation window before ETW arming',
      },
      contention: settled.ok
        ? settled.value
        : contentionFailure(settled.error, contentionProfile),
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const tracePath = path.join(
    traceDirectory,
    `media-priority-${policy}-${timestamp}.etl`,
  )
  const statsPath = path.join(
    traceDirectory,
    `media-priority-${policy}-${timestamp}.tracestats.txt`,
  )
  const wpr = options.wprExecutable ?? 'C:\\Windows\\System32\\wpr.exe'
  let recording
  let start
  try {
    ({ start, recording } = await startWprRecording(wpr, traceDirectory))
  } catch (error) {
    recording?.dispose()
    await contentionPromise
    throw error
  }
  if (start.code !== 0) {
    recording.dispose()
    const settled = await contentionPromise
    return {
      etw: {
        captured: false,
        profiles: recordedWprProfiles(),
        reason: `WPR start failed (${start.code}): ${boundedText(
          start.stderr || start.stdout,
        )}`,
      },
      contention: settled.ok
        ? settled.value
        : contentionFailure(settled.error, contentionProfile),
    }
  }

  const watchdog = scheduleIndependentWprStop(
    wpr,
    tracePath,
    policy,
    ETW_RECORDING_BUDGET_MS,
  )
  const settled = await contentionPromise
  await waitForChildExit(watchdog, 120_000)
  let stop
  try {
    stop = await finalizeWprStop(wpr, tracePath, policy, recording)
  } finally {
    try {
      watchdog.kill('SIGKILL')
    } catch {
      // The independent stopper may already have exited after -stop.
    }
    await recording.cancel()
    recording.dispose()
  }
  const contention = settled.ok
    ? settled.value
    : withRecordedContention(
      undefined,
      settled.error,
      contentionProfile,
    )
  if (stop.code !== 0) {
    return {
      etw: {
        captured: false,
        profiles: recordedWprProfiles(),
        reason: `WPR stop failed (${stop.code}): ${boundedText(
          stop.stderr || stop.stdout,
        )}`,
      },
      contention,
    }
  }

  const trace = await stat(tracePath)
  if (trace.size > MAXIMUM_TRACE_BYTES) {
    await rm(tracePath, { force: true })
    return {
      etw: {
        captured: false,
        reason: `ETW trace exceeded ${MAXIMUM_TRACE_BYTES} byte bound`,
      },
      contention,
    }
  }
  const xperf = options.xperfExecutable ??
    'C:\\Program Files (x86)\\Windows Kits\\10\\Windows Performance Toolkit\\xperf.exe'
  const decoded = await runBoundedProcess(
    xperf,
    [
      '-i',
      tracePath,
      '-target',
      'machine',
      '-a',
      'tracestats',
      '-timespan',
      'actual',
      '-detail',
    ],
    {
      timeoutMs: 120_000,
      maximumOutputBytes: 4 * 1024 * 1024,
      stdoutPath: statsPath,
    },
  )
  const stats = existsSync(statsPath)
    ? await readFile(statsPath, 'utf8')
    : decoded.stdout
  await rotateGeneratedFiles(
    traceDirectory,
    (entry) =>
      entry.startsWith(`media-priority-${policy}-`) && entry.endsWith('.etl'),
    3,
  )
  await rotateGeneratedFiles(
    traceDirectory,
    (entry) =>
      entry.startsWith(`media-priority-${policy}-`) &&
      entry.endsWith('.tracestats.txt'),
    3,
  )
  return {
    etw: {
      captured: decoded.code === 0,
      profiles: recordedWprProfiles(),
      traceBytes: trace.size,
      tracePath,
      statsPath,
      decoder: 'xperf tracestats -timespan actual -detail',
      ...analyzeEtwProviderCoverage(stats),
      providerStats: boundedText(stats, 32 * 1024),
      ...(decoded.code === 0
        ? {}
        : {
            reason: `xperf decode failed (${decoded.code}): ${boundedText(
              decoded.stderr || decoded.stdout,
            )}`,
          }),
    },
    contention,
  }
}

function resolveElectronExecutable() {
  const desktopDirectory = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'apps',
    'desktop',
  )
  const electronModule = require.resolve('electron', {
    paths: [desktopDirectory],
  })
  return require(electronModule)
}

function contentionFailure(error, profile) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    ...(profile
      ? { profile: { name: profile.name, durationMs: profile.durationMs } }
      : {}),
    result: {
      status: 'failed',
      blockers: [],
      failures: [message],
      metrics: {},
    },
  }
}

function withRecordedContention(contention, contentionError, profile) {
  return contention ?? (contentionError ? contentionFailure(contentionError, profile) : null)
}

function defaultExperimentDirectory() {
  return path.resolve(__dirname, '..', 'build', 'media-priority-artifacts')
}

function isCloudSyncedPath(value) {
  return CLOUD_SYNC_PATH.test(String(value).replace(/\//g, '\\'))
}

function resolveTraceDirectory(options = {}) {
  if (options.traceDirectory) return path.resolve(options.traceDirectory)
  if (process.env.SYRNIKE_ETW_TRACE_DIR) {
    return path.resolve(process.env.SYRNIKE_ETW_TRACE_DIR)
  }
  const outputDirectory = options.outputDirectory
    ? path.resolve(options.outputDirectory)
    : ''
  if (outputDirectory && !isCloudSyncedPath(outputDirectory)) {
    return outputDirectory
  }
  if (existsSync('G:\\syrnike13-build-cache')) {
    return path.resolve(LOCAL_TRACE_CACHE)
  }
  return path.join(
    process.env.LOCALAPPDATA || process.env.TEMP || '.',
    'Syrnike',
    'media-priority-etw',
  )
}

function mediaFoundationProfileStart() {
  return `${path.join(__dirname, 'media-priority-mf.wprp')}!MF.light`
}

function recordedWprProfiles() {
  return [...WPR_BUILTIN_PROFILES, 'MF.light']
}

function buildWprStartArguments(traceDirectory) {
  const arguments = []
  for (const profile of WPR_BUILTIN_PROFILES) {
    arguments.push('-start', profile)
  }
  arguments.push('-start', mediaFoundationProfileStart(), '-filemode')
  if (traceDirectory) {
    arguments.push('-recordtempto', path.resolve(traceDirectory))
  }
  return arguments
}

async function runBoundedProcess(executable, arguments, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs)
    ? options.timeoutMs
    : 30_000
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments, {
      env: { ...process.env, ...options.environment },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let stdoutFileError
    const maximumOutputBytes = Number.isSafeInteger(options.maximumOutputBytes)
      ? options.maximumOutputBytes
      : 128 * 1024
    const append = (current, chunk) =>
      boundedText(current + chunk, maximumOutputBytes)
    const stdoutFile = options.stdoutPath
      ? createWriteStream(options.stdoutPath)
      : null
    if (stdoutFile) {
      stdoutFile.on('error', (error) => {
        stdoutFileError = error
      })
    }
    child.stdout.on('data', (chunk) => {
      if (stdoutFile) stdoutFile.write(chunk)
      stdout = append(stdout, chunk.toString())
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk.toString())
    })
    child.once('error', (error) => {
      if (stdoutFile) stdoutFile.destroy()
      reject(error)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      const finish = () => {
        if (stdoutFileError) {
          reject(stdoutFileError)
          return
        }
        resolve({ code, signal, stdout, stderr, timedOut })
      }
      if (stdoutFile) stdoutFile.end(finish)
      else finish()
    })
  })
}

function boundedText(value, maximum = 4 * 1024) {
  const text = String(value ?? '')
  return text.length <= maximum ? text : text.slice(text.length - maximum)
}

async function rotateGeneratedFiles(directory, predicate, keep) {
  const candidates = await Promise.all(
    (await readdir(directory))
      .filter(predicate)
      .map(async (entry) => ({
        entry,
        modifiedAt: (await stat(path.join(directory, entry))).mtimeMs,
      })),
  )
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
  for (const stale of candidates.slice(keep)) {
    await rm(path.join(directory, stale.entry), { force: true })
  }
}

function parseExperimentOptions(argv) {
  const result = { profile: 'ci' }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const value = argv[++index]
    if (value === undefined) throw new Error(`missing value for ${option}`)
    if (option === '--profile') result.profile = value
    else if (option === '--build-dir') result.buildDirectory = value
    else if (option === '--output-dir') result.outputDirectory = value
    else if (option === '--trace-dir') result.traceDirectory = value
    else if (option === '--contention-output-dir') {
      result.contentionOutputDirectory = value
    } else if (option === '--audio-policy-result') {
      result.audioPolicyResult = value
    } else if (option === '--livekit-server') result.liveKitServer = value
    else if (option === '--electron-exe') result.electronExecutable = value
    else if (option === '--wpr-exe') result.wprExecutable = value
    else if (option === '--xperf-exe') result.xperfExecutable = value
    else if (option === '--only-policy') {
      if (!PRIORITY_POLICY_ORDER.includes(value)) {
        throw new Error(`unknown media priority policy: ${value}`)
      }
      result.onlyPolicy = value
    }
    else throw new Error(`unknown media priority experiment option: ${option}`)
  }
  resolveContentionProfile(result.profile)
  return result
}

async function runCli() {
  const options = parseExperimentOptions(process.argv.slice(2))
  const result = await runPriorityMatrix(options)
  result.source = readSourceProvenance()
  const outputDirectory = path.resolve(
    options.outputDirectory ?? defaultExperimentDirectory(),
  )
  await mkdir(outputDirectory, { recursive: true })
  const resultPath = path.join(
    outputDirectory,
    `media-priority-matrix-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(resultPath, JSON.stringify(result, null, 2))
  await rotateGeneratedFiles(
    outputDirectory,
    (entry) => entry.startsWith('media-priority-matrix-') && entry.endsWith('.json'),
    3,
  )
  console.log(JSON.stringify({ resultPath, selection: result.selection }))
  process.exitCode = result.selection.status === 'pass'
    ? 0
    : result.selection.status === 'blocked' ? 2 : 1
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}

module.exports = {
  COMPETING_LIMITS,
  ETW_RECORDING_BUDGET_MS,
  ETW_REQUIRED_WINDOW_MS,
  PRIORITY_POLICY_ORDER,
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
}
