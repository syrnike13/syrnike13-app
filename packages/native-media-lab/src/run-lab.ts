import { AccessToken } from 'livekit-server-sdk'
import { Effect } from 'effect'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIVEKIT_IMAGE =
  'livekit/livekit-server@sha256:e37d68f172556d02aa77968b9fc55ef481468c0315fa38e4fa6c56ce72e3a815'
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const mediaEngineRoot = path.resolve(repoRoot, 'packages', 'windows-media-engine')
const mediaBuildRoot = path.resolve(
  mediaEngineRoot,
  process.env.WINDOWS_MEDIA_BUILD_ROOT ?? 'build',
)
const publisherPath = path.resolve(
  mediaBuildRoot,
  'Release',
  'native_media_lab_publisher.exe',
)
const observerPath = path.resolve(packageRoot, 'dist', 'observer.js')
const mediaRoomSmokePath = path.resolve(
  repoRoot,
  'apps',
  'desktop',
  'out',
  'smoke',
  'media-room-smoke.cjs',
)
const coreTestsPath = path.resolve(
  mediaBuildRoot,
  'Release',
  'media_core_tests.exe',
)
const pnpmScript = process.env.npm_execpath
const serverExecutable = process.env.MEDIA_LAB_SERVER_EXE
const localLiveKitSdkRoot = process.env.MEDIA_LAB_LIVEKIT_SDK_ROOT
const desktopRequire = createRequire(
  path.resolve(repoRoot, 'apps', 'desktop', 'package.json'),
)
const electronExecutable = desktopRequire('electron') as string

class LabFailure extends Error {
  readonly _tag = 'LabFailure'
}

interface RunningProcess {
  readonly child: ChildProcess
  readonly completion: Promise<void>
  readonly output: () => string
}

interface LabResources {
  readonly directory: string
  readonly containerName: string
  readonly processes: Set<RunningProcess>
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isAcceptedReport(value: unknown): value is { readonly accepted: true } {
  return typeof value === 'object' && value !== null &&
    'accepted' in value && value.accepted === true
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): RunningProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const chunks: string[] = []
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new LabFailure(
        `${command} exited with ${code ?? signal ?? 'unknown'}\n${chunks.join('').slice(-8000)}`,
      ))
    })
  })
  void completion.catch(() => undefined)
  return { child, completion, output: () => chunks.join('') }
}

async function stopProcess(processHandle: RunningProcess): Promise<void> {
  if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) return
  processHandle.child.kill()
  await Promise.race([
    processHandle.completion.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ])
}

async function waitForServer(url: string, server: RunningProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new LabFailure(`LiveKit server exited during startup\n${server.output().slice(-8000)}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new LabFailure(`LiveKit server was not ready within ${timeoutMs}ms`)
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new LabFailure(`Timed out waiting for ${filePath}`)
}

async function waitForOutput(
  processHandle: RunningProcess,
  text: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (processHandle.output().includes(text)) return
    if (processHandle.child.exitCode !== null) {
      throw new LabFailure(`Process exited before emitting ${text}\n${processHandle.output()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new LabFailure(`Timed out waiting for process output: ${text}`)
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LabFailure(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function createToken(
  apiKey: string,
  apiSecret: string,
  identity: string,
  canPublish: boolean,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, { identity, ttl: '10m' })
  token.addGrant({
    room: 'native-v2-media-lab',
    roomJoin: true,
    roomCreate: true,
    canPublish,
    canSubscribe: true,
  })
  return token.toJwt()
}

async function executeLab(resources: LabResources): Promise<void> {
  const apiKey = `lab_${randomBytes(12).toString('hex')}`
  const apiSecret = randomBytes(32).toString('base64url')
  const configPath = path.resolve(resources.directory, 'livekit.yaml')
  await writeFile(configPath, [
    'port: 7880',
    'bind_addresses:',
    '  - "0.0.0.0"',
    'rtc:',
    '  tcp_port: 7881',
    '  udp_port: 7882',
    '  use_external_ip: false',
    '  node_ip: "127.0.0.1"',
    'logging:',
    '  level: warn',
    'keys:',
    `  ${apiKey}: ${apiSecret}`,
    '',
  ].join('\n'), 'utf8')

  const server = serverExecutable
    ? runProcess(serverExecutable, ['--config', configPath])
    : runProcess('docker', [
        'run', '--rm', '--name', resources.containerName,
        '-p', '127.0.0.1:7880:7880/tcp',
        '-p', '127.0.0.1:7881:7881/tcp',
        '-p', '127.0.0.1:7882:7882/udp',
        '-v', `${configPath}:/etc/livekit.yaml:ro`,
        LIVEKIT_IMAGE,
        '--config', '/etc/livekit.yaml',
      ])
  resources.processes.add(server)
  await waitForServer('http://127.0.0.1:7880', server, 15_000)

  const [publisherToken, observerToken] = await Promise.all([
    createToken(apiKey, apiSecret, 'native-v2-publisher', true),
    createToken(apiKey, apiSecret, 'neutral-observer', false),
  ])
  const sharedEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    LIVEKIT_URL: 'ws://127.0.0.1:7880',
    MEDIA_LAB_ICE_TRANSPORT: serverExecutable ? 'all' : 'nohost',
    MEDIA_LAB_VIDEO_FRAMES: process.env.MEDIA_LAB_VIDEO_FRAMES ?? '720',
    MEDIA_LAB_VIDEO_FPS: process.env.MEDIA_LAB_VIDEO_FPS ?? '15',
  }
  const scenarioReports: Record<string, unknown> = {}
  const desktopSmokeApp = path.resolve(resources.directory, 'desktop-smoke-app')
  await mkdir(desktopSmokeApp)
  const desktopVersion = process.env.SYRNIKE_DESKTOP_BUILD_VERSION?.trim() ||
    (await readFile(path.resolve(repoRoot, 'VERSION'), 'utf8')).trim()
  await writeFile(
    path.resolve(desktopSmokeApp, 'package.json'),
    `${JSON.stringify({
      name: 'syrnike-native-v2-room-smoke',
      version: desktopVersion,
      main: path.relative(desktopSmokeApp, mediaRoomSmokePath),
    }, null, 2)}\n`,
    'utf8',
  )
  const productionRoomSmoke = runProcess(
    electronExecutable,
    [desktopSmokeApp],
    {
      cwd: path.resolve(repoRoot, 'apps', 'desktop'),
      env: {
        ...sharedEnvironment,
        LIVEKIT_PUBLISHER_TOKEN: publisherToken,
        SYRNIKE_DESKTOP_ROOT: path.resolve(repoRoot, 'apps', 'desktop'),
      },
    },
  )
  resources.processes.add(productionRoomSmoke)
  await withDeadline(
    productionRoomSmoke.completion,
    30_000,
    'production Supervisor room smoke exceeded its deadline',
  )
  const productionMetricsLine = productionRoomSmoke.output()
    .split(/\r?\n/)
    .find((line) => line.startsWith('MEDIA_ROOM_SMOKE '))
  if (productionMetricsLine === undefined) {
    throw new LabFailure(
      `production Supervisor room smoke did not emit metrics\n${productionRoomSmoke.output()}`,
    )
  }
  scenarioReports['production-room-control'] = JSON.parse(
    productionMetricsLine.slice('MEDIA_ROOM_SMOKE '.length),
  )
  const coreTests = runProcess(coreTestsPath, [], {
    cwd: path.dirname(coreTestsPath),
  })
  resources.processes.add(coreTests)
  await withDeadline(coreTests.completion, 10_000, 'Room owner tests exceeded their deadline')
  if (!coreTests.output().includes('media-core-tests:ok')) {
    throw new LabFailure(`Room owner tests did not report success\n${coreTests.output()}`)
  }
  scenarioReports['room-owner-control'] = {
    accepted: true,
    cancellation: 'typed',
    generationFencing: 'passed',
    delayedCompletion: 'passed',
    lifecycleCycles: 50,
  }

  const startPublisher = (
    environment: NodeJS.ProcessEnv,
    args: readonly string[] = [],
  ): RunningProcess => {
    const publisher = runProcess(publisherPath, args, {
      cwd: path.dirname(publisherPath),
      env: {
        ...sharedEnvironment,
        ...environment,
        LIVEKIT_PUBLISHER_TOKEN: publisherToken,
      },
    })
    resources.processes.add(publisher)
    return publisher
  }

  const roomLoss = startPublisher({ MEDIA_LAB_SCENARIO: 'unexpected-room-disconnect' })
  await withDeadline(roomLoss.completion, 30_000, 'Unexpected Room loss exceeded its deadline')
  if (!roomLoss.output().includes('publisher: unexpected Room loss observed')) {
    throw new LabFailure(`SDK Room loss did not reach Engine state\n${roomLoss.output()}`)
  }
  scenarioReports['unexpected-room-disconnect'] = { accepted: true }

  const startObserver = (
    name: string,
    environment: NodeJS.ProcessEnv,
  ): { readonly observer: RunningProcess; readonly readyPath: string; readonly reportPath: string } => {
    const readyPath = path.resolve(resources.directory, `${name}.ready`)
    const reportPath = path.resolve(resources.directory, `${name}.json`)
    const observer = runProcess(process.execPath, [observerPath], {
      cwd: packageRoot,
      env: {
        ...sharedEnvironment,
        ...environment,
        LIVEKIT_OBSERVER_TOKEN: observerToken,
        MEDIA_LAB_REPORT_PATH: reportPath,
        MEDIA_LAB_READY_PATH: readyPath,
      },
    })
    resources.processes.add(observer)
    return { observer, readyPath, reportPath }
  }

  const runObservedScenario = async (
    name: string,
    publisherEnvironment: NodeJS.ProcessEnv,
    observerEnvironment: NodeJS.ProcessEnv,
    observerStartsLate = false,
  ): Promise<void> => {
    let publisher: RunningProcess | undefined
    let observerSetup: ReturnType<typeof startObserver> | undefined
    try {
      if (observerStartsLate) {
        publisher = startPublisher(publisherEnvironment)
        await waitForOutput(publisher, 'publisher: tracks published', 15_000)
        observerSetup = startObserver(name, observerEnvironment)
      } else {
        observerSetup = startObserver(name, observerEnvironment)
        await waitForFile(observerSetup.readyPath, 10_000)
        publisher = startPublisher(publisherEnvironment)
      }
      await withDeadline(
        Promise.all([publisher.completion, observerSetup.observer.completion]),
        75_000,
        `${name} exceeded its 75s process deadline`,
      )
      const reportText = await readFile(observerSetup.reportPath, 'utf8')
      const report: unknown = JSON.parse(reportText)
      if (
        typeof report !== 'object' || report === null ||
        !('accepted' in report) || report.accepted !== true
      ) throw new LabFailure(`Observer rejected ${name}: ${reportText}`)
      scenarioReports[name] = report
    } catch (error: unknown) {
      throw new LabFailure([
        normalizeError(error).message,
        `--- publisher ---\n${publisher?.output().slice(-8000) ?? 'not started'}`,
        `--- observer ---\n${observerSetup?.observer.output().slice(-8000) ?? 'not started'}`,
        `--- server ---\n${server.output().slice(-8000)}`,
      ].join('\n'))
    }
  }

  const runScreenScenario = async (
    mode: string,
    minimumFrames: number,
    args: readonly string[] = [mode],
    expectedSubscriptions = 4,
    observerOverrides: NodeJS.ProcessEnv = {},
  ): Promise<void> => {
    let publisher: RunningProcess | undefined
    let observerSetup: ReturnType<typeof startObserver> | undefined
    try {
      observerSetup = startObserver(mode, {
        MEDIA_LAB_MIN_VIDEO_FRAMES: String(minimumFrames),
        MEDIA_LAB_MIN_CONTENT_CHANGES: String(Math.min(3, Math.max(0, minimumFrames - 1))),
        MEDIA_LAB_MIN_AUDIO_PULSES: '1',
        MEDIA_LAB_EXPECT_SUBSCRIPTIONS: String(expectedSubscriptions),
        MEDIA_LAB_EXPECT_VIDEO_END: 'true',
        MEDIA_LAB_MIN_AUDIO_FRAMES_AFTER_VIDEO_END: '20',
        MEDIA_LAB_ALLOW_VIDEO_GAPS: 'true',
        MEDIA_LAB_MAX_VIDEO_LATENCY_MS: '1500',
        MEDIA_LAB_MAX_FRAME_AGE_MS: '1500',
        MEDIA_LAB_TIMEOUT_MS: process.env.MEDIA_LAB_TIMEOUT_MS ??
          String(mode.includes('repeat') ? 30_000 + screenCycles * 10_000 : 60_000),
        ...observerOverrides,
      })
      await waitForFile(observerSetup.readyPath, 10_000)
      publisher = startPublisher({}, args)
      await withDeadline(
        Promise.all([publisher.completion, observerSetup.observer.completion]),
        // Lifecycle churn includes publish/unpublish acknowledgements and a
        // resource-drain check per cycle. Its total duration is distinct from
        // the unchanged 1500 ms frame-age/latency acceptance limit.
        mode.includes('repeat') ? 45_000 + screenCycles * 10_000 : 75_000,
        `${mode} exceeded its process deadline`,
      )
      const observerReportText = await readFile(observerSetup.reportPath, 'utf8')
      const observerReport: unknown = JSON.parse(observerReportText)
      const reportPrefix = mode.startsWith('screen-gpu-')
        ? 'SCREEN_GPU_REPORT '
        : 'SCREEN_CPU_REPORT '
      const senderLine = publisher.output().split(/\r?\n/).find((line) =>
        line.startsWith(reportPrefix)
      )
      if (senderLine === undefined) {
        throw new LabFailure(`${mode} did not emit ${reportPrefix.trim()}`)
      }
      const senderReport: unknown = JSON.parse(
        senderLine.slice(reportPrefix.length),
      )
      if (
        typeof observerReport !== 'object' || observerReport === null ||
        !('accepted' in observerReport) || observerReport.accepted !== true ||
        typeof senderReport !== 'object' || senderReport === null ||
        !('accepted' in senderReport) || senderReport.accepted !== true
      ) {
        throw new LabFailure(
          `${mode} was rejected\nobserver=${observerReportText}\nsender=${senderLine}`,
        )
      }
      scenarioReports[mode] = {
        sender: senderReport,
        observer: observerReport,
      }
    } catch (error: unknown) {
      throw new LabFailure([
        `${mode}: ${normalizeError(error).message}`,
        `--- publisher ---\n${publisher?.output().slice(-8000) ?? 'not started'}`,
        `--- observer ---\n${observerSetup?.observer.output().slice(-8000) ?? 'not started'}`,
        `--- server ---\n${server.output().slice(-8000)}`,
      ].join('\n'))
    }
  }

  const runScreenObserverRejoin = async (): Promise<void> => {
    let publisher: RunningProcess | undefined
    let first: ReturnType<typeof startObserver> | undefined
    let second: ReturnType<typeof startObserver> | undefined
    const observerEnvironment: NodeJS.ProcessEnv = {
      MEDIA_LAB_MIN_VIDEO_FRAMES: '60',
      MEDIA_LAB_MIN_AUDIO_PULSES: '1',
      MEDIA_LAB_ALLOW_VIDEO_GAPS: 'true',
      MEDIA_LAB_MAX_VIDEO_LATENCY_MS: '1500',
      MEDIA_LAB_MAX_FRAME_AGE_MS: '1500',
      MEDIA_LAB_TIMEOUT_MS: '30000',
    }
    try {
      first = startObserver('screen-cpu-observer-before-leave', {
        ...observerEnvironment,
        MEDIA_LAB_EXPECT_SUBSCRIPTIONS: '4',
      })
      await waitForFile(first.readyPath, 10_000)
      publisher = startPublisher({}, ['screen-cpu-monitor'])
      await withDeadline(
        first.observer.completion,
        45_000,
        'first screen observer did not leave after receiving frames',
      )
      const firstReport: unknown = JSON.parse(await readFile(first.reportPath, 'utf8'))
      if (!isAcceptedReport(firstReport)) {
        throw new LabFailure('first screen observer rejected delivery before leave')
      }

      second = startObserver('screen-cpu-observer-after-rejoin', {
        ...observerEnvironment,
        MEDIA_LAB_MIN_VIDEO_FRAMES: '40',
        MEDIA_LAB_EXPECT_SUBSCRIPTIONS: '2',
      })
      await waitForFile(second.readyPath, 10_000)
      await withDeadline(
        Promise.all([publisher.completion, second.observer.completion]),
        75_000,
        'screen observer rejoin scenario exceeded its deadline',
      )
      const secondReport: unknown = JSON.parse(await readFile(second.reportPath, 'utf8'))
      const senderLine = publisher.output().split(/\r?\n/).find((line) =>
        line.startsWith('SCREEN_CPU_REPORT ')
      )
      if (!isAcceptedReport(secondReport) || senderLine === undefined) {
        throw new LabFailure('screen delivery did not recover after observer rejoin')
      }
      const sender: unknown = JSON.parse(senderLine.slice('SCREEN_CPU_REPORT '.length))
      if (!isAcceptedReport(sender)) {
        throw new LabFailure('screen sender failed after observer rejoin')
      }
      scenarioReports['screen-cpu-observer-rejoin'] = {
        accepted: true,
        beforeLeave: firstReport,
        afterRejoin: secondReport,
        sender,
      }
    } catch (error: unknown) {
      throw new LabFailure([
        normalizeError(error).message,
        `--- publisher ---\n${publisher?.output().slice(-8000) ?? 'not started'}`,
        `--- first observer ---\n${first?.observer.output().slice(-8000) ?? 'not started'}`,
        `--- second observer ---\n${second?.observer.output().slice(-8000) ?? 'not started'}`,
        `--- server ---\n${server.output().slice(-8000)}`,
      ].join('\n'))
    }
  }

  const requestedScreenMode = process.env.MEDIA_LAB_SCREEN_MODE
  const screenCycles = Number(process.env.MEDIA_LAB_SCREEN_CYCLES ?? '30')
  if (!Number.isInteger(screenCycles) || screenCycles < 1 || screenCycles > 30) {
    throw new LabFailure('MEDIA_LAB_SCREEN_CYCLES must be an integer from 1 to 30')
  }
  const screenScenario = async (
    mode: string,
    minimumFrames: number,
    args?: readonly string[],
    expectedSubscriptions?: number,
    observerOverrides?: NodeJS.ProcessEnv,
  ) => {
    const explicitlyRequestedGpuMode =
      mode.startsWith('screen-gpu-') && requestedScreenMode === mode
    const selectedCpuMode = !mode.startsWith('screen-gpu-') &&
      (requestedScreenMode === undefined || requestedScreenMode === mode)
    if (explicitlyRequestedGpuMode || selectedCpuMode) {
      await runScreenScenario(mode, minimumFrames, args, expectedSubscriptions, observerOverrides)
    }
  }
  await screenScenario('screen-cpu-monitor', 80)
  await screenScenario('screen-cpu-window', 80)
  await screenScenario('screen-cpu-slow-pipeline', 20)
  await screenScenario('screen-cpu-resize', 50, ['screen-cpu-resize'], 4, {
    MEDIA_LAB_MIN_RESOLUTION_TRANSITIONS: '1',
  })
  await screenScenario('screen-cpu-source-close', 20)
  await screenScenario(
    'screen-cpu-repeat',
    screenCycles * 10,
    ['screen-cpu-repeat', '--cycles', String(screenCycles)],
    screenCycles + 4,
  )
  if (requestedScreenMode === undefined ||
      requestedScreenMode === 'screen-cpu-late-observer') {
    // Track publication exists before this observer deliberately subscribes.
    await runScreenScenario(
      'screen-cpu-late-observer',
      40,
      ['screen-cpu-monitor'],
      4,
      { MEDIA_LAB_SUBSCRIBE_DELAY_MS: '1000' },
    )
  }
  await screenScenario('screen-cpu-stop-during-conversion', 1)
  if (requestedScreenMode === undefined ||
      requestedScreenMode === 'screen-cpu-room-disconnect') {
    await runScreenScenario(
      'screen-cpu-room-disconnect',
      20,
      ['screen-cpu-room-disconnect'],
      4,
      { MEDIA_LAB_MIN_AUDIO_FRAMES_AFTER_VIDEO_END: '0' },
    )
  }
  if (requestedScreenMode === undefined ||
      requestedScreenMode === 'screen-cpu-observer-rejoin') {
    await runScreenObserverRejoin()
  }
  await screenScenario('screen-gpu-monitor-1080p60', 80)
  await screenScenario('screen-gpu-window-1080p60', 80)
  await screenScenario('screen-gpu-monitor-1440p30', 80)
  await screenScenario(
    'screen-gpu-repeat-720p30',
    screenCycles * 10,
    ['screen-gpu-repeat-720p30', '--cycles', String(screenCycles)],
    screenCycles + 4,
  )

  const screenOnly = process.env.MEDIA_LAB_SCREEN_ONLY === 'true'
  if (!screenOnly) {

  await runObservedScenario('normal', {}, {
    MEDIA_LAB_MIN_VIDEO_FRAMES: process.env.MEDIA_LAB_MIN_VIDEO_FRAMES ?? '600',
    MEDIA_LAB_MIN_AUDIO_PULSES: process.env.MEDIA_LAB_MIN_AUDIO_PULSES ?? '10',
    MEDIA_LAB_TIMEOUT_MS: process.env.MEDIA_LAB_TIMEOUT_MS ?? '65000',
  })
  await runObservedScenario('republish', {
    MEDIA_LAB_SCENARIO: 'republish',
    MEDIA_LAB_VIDEO_FRAMES: '240',
    MEDIA_LAB_VIDEO_FPS: '15',
  }, {
    MEDIA_LAB_MIN_VIDEO_FRAMES: '60',
    MEDIA_LAB_MIN_AUDIO_PULSES: '5',
    MEDIA_LAB_ALLOW_VIDEO_GAPS: 'true',
    MEDIA_LAB_EXPECT_SUBSCRIPTIONS: '4',
    MEDIA_LAB_TIMEOUT_MS: '45000',
  })
  await runObservedScenario('slow-observer', {
    MEDIA_LAB_VIDEO_FRAMES: '180',
    MEDIA_LAB_VIDEO_FPS: '30',
  }, {
    MEDIA_LAB_MIN_VIDEO_FRAMES: '40',
    MEDIA_LAB_MIN_AUDIO_PULSES: '3',
    MEDIA_LAB_ALLOW_VIDEO_GAPS: 'true',
    MEDIA_LAB_OBSERVER_DELAY_MS: '100',
    MEDIA_LAB_MAX_VIDEO_LATENCY_MS: '1000',
    MEDIA_LAB_TIMEOUT_MS: '15000',
  })
  await runObservedScenario('late-observer', {
    MEDIA_LAB_VIDEO_FRAMES: '180',
    MEDIA_LAB_VIDEO_FPS: '15',
  }, {
    MEDIA_LAB_MIN_VIDEO_FRAMES: '100',
    MEDIA_LAB_MIN_AUDIO_PULSES: '5',
    MEDIA_LAB_TIMEOUT_MS: '20000',
  }, true)

  const disconnectBeforePublish = startPublisher({
    MEDIA_LAB_SCENARIO: 'disconnect-before-publish',
  })
  await withDeadline(
    disconnectBeforePublish.completion,
    75_000,
    'disconnect-before-publish exceeded its deadline',
  )
  const disconnectMetricsLine = disconnectBeforePublish.output().split(/\r?\n/).find((line) =>
    line.startsWith('MEDIA_LAB_METRICS '))
  if (disconnectMetricsLine === undefined) {
    throw new LabFailure('disconnect-before-publish did not emit metrics')
  }
  scenarioReports['disconnect-before-publish'] = JSON.parse(
    disconnectMetricsLine.slice('MEDIA_LAB_METRICS '.length),
  )

  const lifecycleChurn = startPublisher({
    MEDIA_LAB_SCENARIO: 'lifecycle-churn',
  })
  await withDeadline(
    lifecycleChurn.completion,
    180_000,
    '50-cycle in-process lifecycle churn exceeded its deadline',
  )
  const lifecycleMetricsLine = lifecycleChurn.output().split(/\r?\n/).find((line) =>
    line.startsWith('MEDIA_LAB_METRICS '))
  if (lifecycleMetricsLine === undefined) {
    throw new LabFailure('in-process lifecycle churn did not emit metrics')
  }
  const lifecycleMetrics = JSON.parse(
    lifecycleMetricsLine.slice('MEDIA_LAB_METRICS '.length),
  ) as {
    cycles?: number
    cancellationCycles?: number
    trackCycles?: number
    handleDelta?: number
    threadDelta?: number
    pendingCallbacks?: number
  }
  if (
    lifecycleMetrics.cycles !== 50 ||
    lifecycleMetrics.cancellationCycles !== 50 ||
    lifecycleMetrics.trackCycles !== 50 ||
    (lifecycleMetrics.handleDelta ?? Number.POSITIVE_INFINITY) > 2 ||
    (lifecycleMetrics.threadDelta ?? Number.POSITIVE_INFINITY) > 0 ||
    lifecycleMetrics.pendingCallbacks !== 0
  ) {
    throw new LabFailure(`in-process lifecycle resources did not return to baseline: ${lifecycleMetricsLine}`)
  }
  scenarioReports['lifecycle-50'] = {
    accepted: true,
    processBoundary: false,
    ...lifecycleMetrics,
  }

  {
    const setup = startObserver('publisher-stops', {
      MEDIA_LAB_MIN_VIDEO_FRAMES: '600',
      MEDIA_LAB_MIN_AUDIO_PULSES: '10',
      MEDIA_LAB_TIMEOUT_MS: '5000',
    })
    await waitForFile(setup.readyPath, 10_000)
    const publisher = startPublisher({ MEDIA_LAB_VIDEO_FRAMES: '600' })
    await waitForOutput(publisher, 'publisher: tracks published', 15_000)
    await stopProcess(publisher)
    await setup.observer.completion.catch(() => undefined)
    const report: unknown = JSON.parse(await readFile(setup.reportPath, 'utf8'))
    if (
      typeof report !== 'object' || report === null ||
      !('accepted' in report) || report.accepted !== false
    ) throw new LabFailure('publisher-stops was not rejected')
    scenarioReports['publisher-stops'] = report
  }

  {
    const setup = startObserver('observer-exits', {
      MEDIA_LAB_MIN_VIDEO_FRAMES: '50',
      MEDIA_LAB_MIN_AUDIO_PULSES: '1',
      MEDIA_LAB_TIMEOUT_MS: '10000',
    })
    await waitForFile(setup.readyPath, 10_000)
    await stopProcess(setup.observer)
    const publisher = startPublisher({
      MEDIA_LAB_VIDEO_FRAMES: '60',
      MEDIA_LAB_WAIT_FOR_SUBSCRIBERS: 'false',
    })
    await withDeadline(
      publisher.completion,
      20_000,
      'publisher hung after observer exited unexpectedly',
    )
    scenarioReports['observer-exits'] = { accepted: true, publisherCompleted: true }
  }
  }

  const report = {
    schemaVersion: 2,
    accepted: true,
    generatedAt: new Date().toISOString(),
    scenarios: scenarioReports,
  }
  const reportText = `${JSON.stringify(report, null, 2)}\n`

  const artifactDirectory = path.resolve(packageRoot, 'artifacts')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(artifactDirectory, { recursive: true }))
  const artifactPath = path.resolve(artifactDirectory, 'latest-report.json')
  await writeFile(artifactPath, reportText, 'utf8')
  process.stdout.write(`Native v2 Media Lab passed. Report: ${artifactPath}\n`)
  process.stdout.write(`${reportText}\n`)
}

const program = Effect.scoped(Effect.gen(function* () {
  yield* Effect.tryPromise({
    try: async () => {
      if (serverExecutable) {
        if (!path.isAbsolute(serverExecutable) || !existsSync(serverExecutable)) {
          throw new LabFailure('MEDIA_LAB_SERVER_EXE must name an existing absolute path')
        }
      } else {
        const docker = runProcess('docker', ['info', '--format', '{{.ServerVersion}}'])
        await docker.completion
      }
      if (pnpmScript === undefined) {
        throw new LabFailure('npm_execpath is required to launch pnpm reproducibly')
      }
      const pnpmIsExecutable = path.extname(pnpmScript).toLowerCase() === '.exe'
      const build = runProcess(pnpmIsExecutable ? pnpmScript : process.execPath, [
        ...(pnpmIsExecutable ? [] : [pnpmScript]),
        '--filter', '@syrnike13/windows-media-engine', 'build:lab',
      ], { cwd: repoRoot })
      await build.completion
      const platformBuild = runProcess(
        pnpmIsExecutable ? pnpmScript : process.execPath,
        [
          ...(pnpmIsExecutable ? [] : [pnpmScript]),
          '--filter', '@syrnike13/platform', 'build',
        ],
        { cwd: repoRoot },
      )
      await platformBuild.completion
      const desktopShellBuild = runProcess(
        pnpmIsExecutable ? pnpmScript : process.execPath,
        [
          ...(pnpmIsExecutable ? [] : [pnpmScript]),
          '--filter', '@syrnike13/desktop', 'exec', 'tsup',
        ],
        { cwd: repoRoot },
      )
      await desktopShellBuild.completion
      const desktopSmokeBuild = runProcess(
        pnpmIsExecutable ? pnpmScript : process.execPath,
        [
          ...(pnpmIsExecutable ? [] : [pnpmScript]),
          '--filter', '@syrnike13/desktop', 'build:media-room-smoke',
        ],
        { cwd: repoRoot },
      )
      await desktopSmokeBuild.completion
      if (localLiveKitSdkRoot !== undefined) {
        if (!path.isAbsolute(localLiveKitSdkRoot)) {
          throw new LabFailure('MEDIA_LAB_LIVEKIT_SDK_ROOT must be an absolute path')
        }
        for (const fileName of ['livekit.dll', 'livekit_ffi.dll']) {
          const source = path.resolve(localLiveKitSdkRoot, 'bin', fileName)
          if (!existsSync(source)) {
            throw new LabFailure(`Local LiveKit SDK is missing ${source}`)
          }
          await copyFile(source, path.resolve(path.dirname(publisherPath), fileName))
        }
      }
    },
    catch: normalizeError,
  })

  const resources = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async (): Promise<LabResources> => ({
        directory: await mkdtemp(path.join(tmpdir(), 'syrnike-native-media-lab-')),
        containerName: `syrnike-native-media-lab-${process.pid}-${Date.now()}`,
        processes: new Set(),
      }),
      catch: normalizeError,
    }),
    (owned) => Effect.tryPromise({
      try: async () => {
        for (const processHandle of owned.processes) await stopProcess(processHandle)
        if (!serverExecutable) {
          const cleanup = runProcess('docker', ['rm', '-f', owned.containerName])
          await cleanup.completion.catch(() => undefined)
        }
        await rm(owned.directory, { recursive: true, force: true })
      },
      catch: normalizeError,
    }).pipe(Effect.ignore),
  )

  yield* Effect.tryPromise({
    try: () => executeLab(resources),
    catch: normalizeError,
  })
}))

Effect.runPromise(program).catch(async (error: unknown) => {
  const failure = normalizeError(error)
  const artifactDirectory = path.resolve(packageRoot, 'artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(
    path.resolve(artifactDirectory, 'latest-report.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      accepted: false,
      generatedAt: new Date().toISOString(),
      failure: failure.message,
    }, null, 2)}\n`,
    'utf8',
  )
  process.stderr.write(`${failure.message}\n`)
  process.exitCode = 1
})
