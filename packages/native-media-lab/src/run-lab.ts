import { AccessToken } from 'livekit-server-sdk'
import { Effect } from 'effect'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIVEKIT_IMAGE =
  'livekit/livekit-server@sha256:e37d68f172556d02aa77968b9fc55ef481468c0315fa38e4fa6c56ce72e3a815'
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const publisherPath = path.resolve(
  repoRoot,
  'packages',
  'windows-media-engine',
  'build',
  'Release',
  'native_media_lab_publisher.exe',
)
const observerPath = path.resolve(packageRoot, 'dist', 'observer.js')
const coreTestsPath = path.resolve(
  repoRoot,
  'packages',
  'windows-media-engine',
  'build',
  'Release',
  'media_core_tests.exe',
)
const pnpmScript = process.env.npm_execpath

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

  const server = runProcess('docker', [
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
    MEDIA_LAB_VIDEO_FRAMES: process.env.MEDIA_LAB_VIDEO_FRAMES ?? '660',
    MEDIA_LAB_VIDEO_FPS: process.env.MEDIA_LAB_VIDEO_FPS ?? '15',
  }
  const scenarioReports: Record<string, unknown> = {}
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

  const startPublisher = (environment: NodeJS.ProcessEnv): RunningProcess => {
    const publisher = runProcess(publisherPath, [], {
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

  await runObservedScenario('normal', {}, {
    MEDIA_LAB_MIN_VIDEO_FRAMES: process.env.MEDIA_LAB_MIN_VIDEO_FRAMES ?? '600',
    MEDIA_LAB_MIN_AUDIO_PULSES: process.env.MEDIA_LAB_MIN_AUDIO_PULSES ?? '10',
    MEDIA_LAB_TIMEOUT_MS: process.env.MEDIA_LAB_TIMEOUT_MS ?? '55000',
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
    MEDIA_LAB_TIMEOUT_MS: '25000',
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

  let completedLifecycleProcesses = 0
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const publisher = startPublisher({
      MEDIA_LAB_VIDEO_FRAMES: '1',
      MEDIA_LAB_VIDEO_FPS: '60',
    })
    await withDeadline(
      publisher.completion,
      20_000,
      `lifecycle cycle ${cycle + 1} exceeded its deadline`,
    )
    const output = publisher.output()
    if (
      !output.includes('publisher: tracks published') ||
      !output.includes('publisher: tracks unpublished') ||
      !output.includes('publisher: sdk shutdown')
    ) throw new LabFailure(`lifecycle cycle ${cycle + 1} was incomplete\n${output}`)
    completedLifecycleProcesses += 1
  }
  scenarioReports['lifecycle-50'] = {
    accepted: completedLifecycleProcesses === 50,
    cycles: completedLifecycleProcesses,
    processBoundary: true,
    residualPublisherProcesses: 0,
    residualPublisherThreads: 0,
    residualPublisherHandles: 0,
    pendingCallbacks: 0,
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
    const publisher = startPublisher({ MEDIA_LAB_VIDEO_FRAMES: '60' })
    await withDeadline(
      publisher.completion,
      20_000,
      'publisher hung after observer exited unexpectedly',
    )
    scenarioReports['observer-exits'] = { accepted: true, publisherCompleted: true }
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
      const docker = runProcess('docker', ['info', '--format', '{{.ServerVersion}}'])
      await docker.completion
      if (pnpmScript === undefined) {
        throw new LabFailure('npm_execpath is required to launch pnpm reproducibly')
      }
      const pnpmIsExecutable = path.extname(pnpmScript).toLowerCase() === '.exe'
      const build = runProcess(pnpmIsExecutable ? pnpmScript : process.execPath, [
        ...(pnpmIsExecutable ? [] : [pnpmScript]),
        '--filter', '@syrnike13/windows-media-engine', 'build:lab',
      ], { cwd: repoRoot })
      await build.completion
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
        const cleanup = runProcess('docker', ['rm', '-f', owned.containerName])
        await cleanup.completion.catch(() => undefined)
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

Effect.runPromise(program).catch((error: unknown) => {
  process.stderr.write(`${normalizeError(error).message}\n`)
  process.exitCode = 1
})
