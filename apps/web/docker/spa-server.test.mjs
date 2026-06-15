import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createSpaStaticServer } from './spa-server.mjs'

const tempDirs = []

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

describe('createSpaStaticServer media types', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it('serves png loading animations as image/png', async () => {
    const clientDir = await mkdtemp(join(tmpdir(), 'syrnike-spa-'))
    tempDirs.push(clientDir)
    await writeFile(join(clientDir, 'loading-easter-egg-alpha.png'), 'png')

    const { server, listen } = createSpaStaticServer({
      clientDir,
      host: '127.0.0.1',
      port: 0,
    })

    await listen()

    try {
      const address = server.address()

      if (address === null || typeof address === 'string') {
        throw new Error('Expected server to listen on a TCP port')
      }

      const response = await fetch(
        `http://127.0.0.1:${address.port}/loading-easter-egg-alpha.png`,
        { method: 'HEAD' },
      )

      expect(response.headers.get('content-type')).toBe('image/png')
    } finally {
      await closeServer(server)
    }
  })

  it('serves easter notes as audio/ogg', async () => {
    const clientDir = await mkdtemp(join(tmpdir(), 'syrnike-spa-'))
    tempDirs.push(clientDir)
    await writeFile(join(clientDir, 'd6.ogg'), 'ogg')

    const { server, listen } = createSpaStaticServer({
      clientDir,
      host: '127.0.0.1',
      port: 0,
    })

    await listen()

    try {
      const address = server.address()

      if (address === null || typeof address === 'string') {
        throw new Error('Expected server to listen on a TCP port')
      }

      const response = await fetch(
        `http://127.0.0.1:${address.port}/d6.ogg`,
        { method: 'HEAD' },
      )

      expect(response.headers.get('content-type')).toBe('audio/ogg')
    } finally {
      await closeServer(server)
    }
  })
})
