import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { defineConfig } from 'tsup'

const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: path.resolve(import.meta.dirname, '..', '..'),
  encoding: 'utf8',
}).trim()
const releaseChannel = process.env.SYRNIKE_DESKTOP_CHANNEL ?? 'stable'

if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
  throw new Error('Media room smoke requires a full commit SHA')
}
if (releaseChannel !== 'stable' && releaseChannel !== 'nightly') {
  throw new Error(`Unsupported desktop release channel: ${releaseChannel}`)
}

export default defineConfig({
  entry: ['src/main/media-runtime/media-room-smoke.ts'],
  outDir: 'out/smoke',
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['electron'],
  noExternal: ['@syrnike13/platform', 'effect'],
  define: {
    __DESKTOP_RELEASE_CHANNEL__: JSON.stringify(releaseChannel),
    __DESKTOP_COMMIT_SHA__: JSON.stringify(commitSha),
  },
})
