import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { app } from 'electron'

const MAX_RENDERER_BYTES = 2 * 1024 * 1024
const MAX_NATIVE_BYTES = 6 * 1024 * 1024
const MAX_NATIVE_SESSIONS = 3

export async function createDesktopDiagnosticBundle(rendererJsonl: string) {
  if (typeof rendererJsonl !== 'string') {
    throw new Error('Diagnostic records must be a string')
  }
  if (Buffer.byteLength(rendererJsonl) > MAX_RENDERER_BYTES) {
    throw new Error('Renderer diagnostic records are too large')
  }

  const nativeRecords = await readRecentNativeDiagnostics()
  const combined = `${rendererJsonl.trimEnd()}\n${nativeRecords}`
  return new Uint8Array(gzipSync(combined, { level: 6 }))
}

async function readRecentNativeDiagnostics() {
  const root = path.join(app.getPath('userData'), 'logs', 'native-media-diagnostics')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('native-'))
      .map(async (entry) => {
        const directory = path.join(root, entry.name)
        return { directory, modifiedAt: (await stat(directory)).mtimeMs }
      }),
  )
  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)

  let remaining = MAX_NATIVE_BYTES
  const chunks: string[] = []
  for (const session of sessions.slice(0, MAX_NATIVE_SESSIONS)) {
    const files = await readdir(session.directory, { withFileTypes: true }).catch(
      () => [],
    )
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl') || remaining <= 0) continue
      const value = await readFile(path.join(session.directory, file.name)).catch(
        () => Buffer.alloc(0),
      )
      const start = Math.max(0, value.length - remaining)
      let bounded = value.subarray(start)
      if (start > 0) {
        const firstCompleteLine = bounded.indexOf(0x0a)
        bounded =
          firstCompleteLine === -1
            ? Buffer.alloc(0)
            : bounded.subarray(firstCompleteLine + 1)
      }
      chunks.push(bounded.toString('utf8'))
      remaining -= bounded.length
    }
  }
  return chunks.join('\n')
}
