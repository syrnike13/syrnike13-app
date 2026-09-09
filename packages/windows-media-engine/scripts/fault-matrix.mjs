import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const requiredFaults = [
  'wgc-source-closed', 'wgc-close-racing-frame', 'wgc-frame-after-stop',
  'wgc-prepare-failure', 'wgc-concurrent-stop',
  'dxgi-access-lost', 'dxgi-device-removed',
  'capture-candidate-failure', 'capture-retry-exhaustion',
  'capture-rolling-attempt-budget', 'capture-concurrent-failure-fences',
  'encoder-input-without-output', 'encoder-bitrate-unsupported', 'encoder-bitrate-rejected',
  'sdk-submit-duplicate', 'sdk-publish-never-completes',
  'sdk-submit-never-completes', 'sdk-unpublish-never-completes',
  'remote-video-late-decoded',
  'screen-audio-superseded-start', 'screen-audio-target-exit',
  'screen-audio-retirement-during-new-intent', 'screen-audio-concurrent-stop',
  'microphone-active-device-loss', 'microphone-no-progress', 'microphone-candidate-failure',
  'microphone-owner-latest-intent', 'microphone-owner-pending-shutdown',
  'output-device-invalidated', 'output-no-progress', 'output-candidate-failure',
  'output-retry-budget', 'output-candidate-cancelled',
  'output-owner-latest-intent', 'output-owner-pending-shutdown',
  'camera-device-removed', 'camera-reader-no-callback', 'camera-candidate-cancelled',
  'room-connect-never-completes', 'room-disconnect-never-completes', 'room-cancel-never-completes',
]

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const natural = value => Number.isSafeInteger(value) && value >= 0

// Keep only bounded, known fields. Raw CTest logs can contain local paths or
// endpoint names and are deliberately not copied into the shareable artifact.
export function assessFaults(records, expected, required = requiredFaults) {
  const faults = []
  const seen = new Set()
  const violations = []
  for (const record of records) {
    if (!isRecord(record) || typeof record.id !== 'string' || !required.includes(record.id)) {
      violations.push('unexpected-or-malformed-fault')
      continue
    }
    const id = record.id
    if (seen.has(id)) violations.push(`${id}:duplicate-result`)
    seen.add(id)
    const problems = []
    const build = record.build
    const validBuild = isRecord(build) && build.commit === expected.commit &&
      build.configuration === expected.configuration && build.asan === expected.asan && natural(build.msvc)
    if (!validBuild) problems.push('build-mismatch')
    if (record.passed !== 100 || record.required !== 100 || !natural(record.warmup)) problems.push('incomplete-repetitions')
    if (record.ownerChecksPassed !== true) problems.push('owner-checks-failed')
    if (record.resourceChecksPassed !== true) problems.push('resource-checks-failed')
    if (typeof record.maximumIterationMs !== 'number' || !Number.isFinite(record.maximumIterationMs) ||
        record.maximumIterationMs < 0) problems.push('missing-duration')
    const resources = record.resources
    const validResources = isRecord(resources) && ['baseline', 'final', 'delta'].every(key => isRecord(resources[key])) &&
      ['handles', 'threads'].every(key => natural(resources.baseline[key]) && natural(resources.final[key]) &&
        Number.isSafeInteger(resources.delta[key]) &&
        resources.delta[key] === resources.final[key] - resources.baseline[key])
    if (!validResources) problems.push('invalid-resource-evidence')
    else if (resources.delta.handles > 0 || resources.delta.threads > 0) problems.push('positive-resource-growth')
    faults.push({
      id,
      passed: natural(record.passed) ? record.passed : null,
      required: 100,
      warmup: natural(record.warmup) ? record.warmup : null,
      build: validBuild ? { ...expected, msvc: build.msvc } : null,
      maximumIterationMs: typeof record.maximumIterationMs === 'number' && Number.isFinite(record.maximumIterationMs)
        ? record.maximumIterationMs : null,
      ownerChecksPassed: record.ownerChecksPassed === true,
      resourceChecksPassed: record.resourceChecksPassed === true,
      resources: validResources ? Object.fromEntries(['baseline', 'final', 'delta'].map(key => [key, {
        handles: resources[key].handles, threads: resources[key].threads,
      }])) : null,
      status: problems.length ? 'failed' : 'passed',
      problems,
    })
    violations.push(...problems.map(problem => `${id}:${problem}`))
  }
  const missing = required.filter(id => !seen.has(id))
  return { status: violations.length || missing.length ? 'failed' : 'passed', faults, missing, violations }
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function parseCTestCompletion(line) {
  const completed = line.match(/^\s*\d+\/\d+\s+Test\s+#\s*\d+:\s+([a-zA-Z0-9_.-]+)\s+\.{2,}\s+(.+)$/)
  return completed ? { name: completed[1], passed: /^Passed\b/.test(completed[2]) } : undefined
}

const nativeResultPrefix = /^(?:\d+:\s*)?NATIVE_FAULT_RESULT /

export function createCTestLineReader(onLine, onError) {
  let pending = ''
  let discarding = false
  return {
    write(chunk) {
      let start = 0
      while (start < chunk.length) {
        const end = chunk.indexOf('\n', start)
        const fragment = chunk.slice(start, end < 0 ? chunk.length : end)
        if (!discarding) {
          if (pending.length + fragment.length > 65_536) {
            // Source enumeration can legitimately print a large JSON line.
            // Discard unrelated output, but never silently truncate evidence.
            if (nativeResultPrefix.test((pending + fragment.slice(0, 256)).slice(0, 256)))
              onError('oversized-native-result')
            pending = ''
            discarding = true
          } else pending += fragment
        }
        if (end < 0) break
        if (!discarding) onLine(pending.replace(/\r$/, ''))
        pending = ''
        discarding = false
        start = end + 1
      }
    },
    end() { if (!discarding && pending) onLine(pending.replace(/\r$/, '')) },
  }
}

async function runSuite(ctest, buildRoot, configuration) {
  const records = []
  const parsingErrors = []
  const tests = []
  const parsingError = reason => { if (parsingErrors.length < 256) parsingErrors.push(reason) }
  const child = spawn(ctest, ['--test-dir', buildRoot, '-C', configuration, '--verbose'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  function readLines(stream) {
    stream.setEncoding('utf8')
    const consume = line => {
      const marker = line.match(nativeResultPrefix)
      if (marker) {
        try {
          if (records.length >= 256) throw new Error('too-many-records')
          records.push(JSON.parse(line.slice(marker[0].length)))
        } catch { parsingError('invalid-native-result') }
      } else if (/^\s*(?:\d+\/\d+\s+Test\s+#|Start\s+\d+:|\d+% tests passed|Total Test time)/.test(line)) {
        process.stdout.write(`${line}\n`)
        const completed = parseCTestCompletion(line)
        if (completed && tests.length < 512) tests.push(completed)
      }
    }
    const reader = createCTestLineReader(consume, parsingError)
    stream.on('data', chunk => reader.write(chunk))
    stream.on('end', () => reader.end())
  }
  readLines(child.stdout)
  readLines(child.stderr)
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve(code ?? -1))
  })
  return { records, parsingErrors, tests, exitCode }
}

async function main() {
  if (platform() !== 'win32') throw new Error('Native fault qualification requires Windows')
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const repoRoot = path.resolve(packageRoot, '../..')
  const args = process.argv.slice(2)
  let configuration = 'Release'
  let output
  let asan = false
  for (let index = 0; index < args.length; ++index) {
    if (args[index] === '--config') configuration = args[++index]
    else if (args[index] === '--output') {
      output = args[++index]
      if (!output || output.startsWith('--')) throw new Error('--output requires a file path')
    }
    else if (args[index] === '--asan') asan = true
    else throw new Error('Expected --config, --output or --asan')
  }
  if (!['Debug', 'Release'].includes(configuration)) throw new Error('Configuration must be Debug or Release')
  const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim()
  const commit = git(['rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40}$/.test(commit) || git(['diff', '--name-only', 'HEAD']).length)
    throw new Error('Commit all tracked changes before recording exact-commit evidence')
  const buildRoot = path.resolve(packageRoot, process.env.WINDOWS_MEDIA_BUILD_ROOT || 'build')
  const cache = readFileSync(path.join(buildRoot, 'CMakeCache.txt'), 'utf8')
  const cacheValue = name => cache.match(new RegExp(`^${name}:[^=]+=(.*)$`, 'm'))?.[1].trim()
  if (cacheValue('WINDOWS_MEDIA_COMMIT') !== commit || cacheValue('WINDOWS_MEDIA_BUILD_LAB') !== 'ON' ||
      cacheValue('WINDOWS_MEDIA_ENABLE_ASAN') !== (asan ? 'ON' : 'OFF'))
    throw new Error('Rebuild this commit with the requested configuration, ASan setting and --lab before qualification')
  const cmake = cacheValue('CMAKE_COMMAND')
  if (!cmake) throw new Error('Build cache has no CMake tool location')
  const ctest = path.join(path.dirname(cmake), 'ctest.exe')
  const manifest = JSON.parse(execFileSync(ctest, ['--test-dir', buildRoot, '-C', configuration, '--show-only=json-v1'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  }))
  if (!Array.isArray(manifest.tests) || !manifest.tests.length) throw new Error('CTest suite is empty')
  const names = manifest.tests.map(test => test.name)
  if (!names.includes('microphone-platform-faults') || !names.includes('output-platform-faults') ||
      !names.includes('encoder-bitrate-unsupported') || !names.includes('encoder-bitrate-rejected'))
    throw new Error('CTest suite is missing required platform fault tests')
  const binaryRoot = path.join(buildRoot, configuration)
  const files = readdirSync(binaryRoot).filter(name => /\.(exe|dll|node)$/.test(name)).sort()
  const binaries = []
  for (const name of files) binaries.push({ name, sha256: await sha256(path.join(binaryRoot, name)) })
  const startedAt = new Date().toISOString()
  const run = await runSuite(ctest, buildRoot, configuration)
  const assessment = assessFaults(run.records, { commit, configuration, asan })
  if (run.tests.length !== names.length || names.some(name => run.tests.filter(test => test.name === name && test.passed).length !== 1))
    run.parsingErrors.push('incomplete-or-failed-full-suite')
  // Do not qualify a run whose checkout or binaries changed while tests ran.
  if (git(['rev-parse', 'HEAD']) !== commit || git(['diff', '--name-only', 'HEAD']).length)
    run.parsingErrors.push('source-changed-during-run')
  for (const binary of binaries) {
    if (await sha256(path.join(binaryRoot, binary.name)) !== binary.sha256)
      run.parsingErrors.push('binary-changed-during-run')
  }
  const passed = run.exitCode === 0 && !run.parsingErrors.length && assessment.status === 'passed'
  const artifact = {
    schemaVersion: 1,
    scope: 'native-owner-faults',
    ...assessment,
    status: passed ? 'passed' : 'failed',
    sourceCommit: commit, configuration, asan,
    machine: { platform: platform(), arch: arch(), osRelease: release() },
    startedAt, finishedAt: new Date().toISOString(),
    suite: { tests: names, results: run.tests, ctestExitCode: run.exitCode, parsingErrors: run.parsingErrors },
    requiredFaults, binaries,
    remainingEvidence: ['neutral-observer-continuity', 'active-product-host-and-renderer-replay',
      'combined-faults-and-app-shutdown', 'cross-layer-incident-timeline', 'other-build-configurations'],
  }
  const destination = path.resolve(output || path.join(repoRoot, '.codex-tmp/native-faults',
    `${commit}-${configuration}${asan ? '-asan' : ''}.json`))
  mkdirSync(path.dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(artifact, null, 2)}\n`)
  console.info(`Native owner matrix: ${artifact.status}; ${assessment.faults.length}/${requiredFaults.length} results. Product and observer evidence remain separate.`)
  process.exitCode = passed ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
