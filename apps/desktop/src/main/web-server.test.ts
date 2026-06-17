import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startEmbeddedWebServer, type EmbeddedWebServer } from './web-server'

const tempDirs: string[] = []

async function closeServer(server: EmbeddedWebServer) {
  await server.close()
}

describe('desktop embedded web server media types', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it('serves easter notes as audio/ogg', async () => {
    const distRoot = await mkdtemp(path.join(tmpdir(), 'syrnike-desktop-web-'))
    tempDirs.push(distRoot)
    const clientDir = path.join(distRoot, 'client')
    const noteDir = path.join(clientDir, 'easter', 'notes')
    await mkdir(noteDir, { recursive: true })
    await writeFile(path.join(clientDir, '_shell.html'), '<html></html>')
    await writeFile(path.join(noteDir, 'd6.ogg'), 'ogg')

    const server = await startEmbeddedWebServer(distRoot)

    try {
      const response = await fetch(`${server.url}/easter/notes/d6.ogg`, {
        method: 'HEAD',
      })

      expect(response.headers.get('content-type')).toBe('audio/ogg')
    } finally {
      await closeServer(server)
    }
  })
})
