import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
}))

import { createDesktopDiagnosticBundle } from './diagnostic-bundle'

describe('desktop diagnostic bundle', () => {
  beforeEach(async () => {
    state.userData = await mkdtemp(path.join(tmpdir(), 'syrnike-diagnostics-'))
  })

  it('combines renderer and redacted native JSONL into gzip', async () => {
    const session = path.join(
      state.userData,
      'logs',
      'native-media-diagnostics',
      'native-media-test',
    )
    await mkdir(session, { recursive: true })
    await writeFile(
      path.join(session, 'native.jsonl'),
      '{"role":"native","event":"screen_started"}\n',
      'utf8',
    )

    const compressed = await createDesktopDiagnosticBundle(
      '{"type":"manifest","source":"desktop"}\n{"event":"voice_failed"}',
    )
    const value = gunzipSync(compressed).toString('utf8')
    expect(value).toContain('voice_failed')
    expect(value).toContain('screen_started')
    const records = value.split('\n').map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({ record_type: 'manifest' })
    expect(records).toContainEqual(
      expect.objectContaining({
        source: 'electron-main',
        event: 'diagnostic.bundle_inventory',
        data: expect.objectContaining({
          native_limit_bytes: 30 * 1024 * 1024,
          native_sessions_found: 1,
          native_files_included: 1,
          native_records_included: 1,
          native_records_by_source: { native: 1 },
        }),
      }),
    )
    for (const record of records) {
      expect(record).toMatchObject({
        schema: 'syrnike.diagnostic',
        version: 1,
      })
    }
  })

  it('rejects unbounded renderer input', async () => {
    await expect(
      createDesktopDiagnosticBundle('x'.repeat(2 * 1024 * 1024 + 1)),
    ).rejects.toThrow('too large')
  })
})
