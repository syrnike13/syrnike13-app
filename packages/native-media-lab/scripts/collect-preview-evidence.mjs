import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { verifyPreview } from './verify-preview.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const artifacts = path.join(root, 'packages/native-media-lab/artifacts')
const sha256 = data => createHash('sha256').update(data).digest('hex')
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const sourcePaths = git(['ls-files', '--cached', '--others', '--exclude-standard', '--',
  'packages/windows-media-engine/native', 'apps/desktop/src/main/media-runtime',
  'apps/desktop/scripts/preview-lab', 'packages/native-media-lab/scripts', 'packages/native-media-lab/src/marker.ts'])
  .split('\n').sort()
const sources = await Promise.all(sourcePaths.map(async file => ({ path: file, sha256: sha256(await readFile(path.join(root, file))) })))
const evidence = { schemaVersion: 1, issue: 123, generatedAt: new Date().toISOString(),
  source: { baseCommit: git(['rev-parse', 'HEAD']),
    state: git(['status', '--porcelain', '--', ...sourcePaths]) ? 'uncommitted working tree' : 'committed',
    aggregateSha256: sha256(JSON.stringify(sources)), files: sources },
  sdk: { release: 'v1.10.0-syrnike.4', commit: '7e3a9465733666f6fa463c58d842e3702ed2e646' },
  binaries: [], scenarios: [], pairedReports: {},
  limitations: [
    'Local Windows GPU qualification; no NVIDIA/AMD/Intel or hybrid matrix is claimed.',
    'The initial monitor run overlapping the full desktop test suite failed p95 age (293ms) and gap/FPS limits. The separate monitor run passed unchanged thresholds; loaded-machine qualification remains outstanding.',
    'Managed texture backing estimates exclude opaque encoder/decoder/driver allocations. Publication reserve covers existing output profiles and source sizes through 3840x2160.',
    'Full 100ms preview reports remain in native-media-lab/artifacts and are identified by SHA256. Embedded paired preview reports retain one sample per second plus the final sample; acceptance evaluates every original sample.',
  ] }
for (const file of ['preview_bridge_lab.node', 'livekit.dll', 'livekit_ffi.dll', 'source_window_fixture.exe', 'monitor_pattern_fixture.exe']) {
  const absolute = path.join(root, 'packages/windows-media-engine/build/Release', file)
  evidence.binaries.push({ name: file, sha256: sha256(await readFile(absolute)) })
}
if (process.env.MEDIA_LAB_SERVER_EXE) evidence.binaries.push({ name: 'project-livekit-server.exe',
  sha256: sha256(await readFile(process.env.MEDIA_LAB_SERVER_EXE)) })
for (const scenario of ['normal', 'monitor', 'slow', 'never-release', 'cycles', 'reload', 'close', 'resize',
  'source-close', 'pressure', 'late-join', 'publication-stop']) {
  const previewBytes = await readFile(path.join(artifacts, `preview-${scenario}.json`))
  const observerBytes = await readFile(path.join(artifacts, `preview-${scenario}.json.observer.json`))
  const preview = JSON.parse(previewBytes), observer = JSON.parse(observerBytes)
  const errors = verifyPreview(preview, observer, scenario)
  if (errors.length) throw Error(`${scenario}: ${errors.join('; ')}`)
  evidence.scenarios.push({ scenario, accepted: true, previewReportSha256: sha256(previewBytes),
    observerReportSha256: sha256(observerBytes), previewFrames: preview.frames,
    observerFrames: observer.frames, observerFps: observer.averageFps, observerP95AgeMs: observer.p95AgeMs,
    observerMaximumGapMs: observer.maximumGapMs, publicationIds: observer.subscriptions,
    sdkReconnects: preview.final.sdkReconnects, maximumPreviewBytes: Math.max(...preview.samples.map(sample => sample.backingBytes)),
    publicationConsumed: preview.final.publicationConsumed, previewDrops: preview.final.poolDrops,
    pressureDrops: preview.final.pressureDrops, final: preview.final })
  if (['normal', 'never-release', 'pressure'].includes(scenario)) evidence.pairedReports[scenario] = {
    preview: { ...preview, samples: preview.samples.filter((_, index) => index % 10 === 0 || index === preview.samples.length - 1) }, observer,
  }
}
const output = path.join(root, 'docs/native-v2/local-screen-preview-acceptance.json')
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
console.log(`Verified ${evidence.scenarios.length} scenarios; wrote ${output}`)
