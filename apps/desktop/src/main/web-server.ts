import { createServer, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

type FetchEntry = {
  fetch: (request: Request) => Promise<Response>
}

export type EmbeddedWebServer = {
  url: string
  port: number
  close(): Promise<void>
}

function nodeRequestToFetch(
  req: import('node:http').IncomingMessage,
  serverPort: number,
) {
  const hostHeader = req.headers.host
  const host = hostHeader?.includes(':')
    ? hostHeader
    : `${hostHeader ?? '127.0.0.1'}:${serverPort}`
  const url = `http://${host}${req.url ?? '/'}`
  const headers = new Headers()

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }

  const hasBody =
    req.method !== undefined &&
    req.method !== 'GET' &&
    req.method !== 'HEAD'

  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: hasBody ? 'half' : undefined,
  } as RequestInit)
}

async function writeFetchResponse(
  res: import('node:http').ServerResponse,
  response: Response,
) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return
    res.setHeader(key, value)
  })

  if (!response.body) {
    res.end()
    return
  }

  for await (const chunk of Readable.fromWeb(response.body as never)) {
    res.write(chunk)
  }
  res.end()
}

async function loadTanStackServer(webDistRoot: string): Promise<FetchEntry> {
  const serverModulePath = path.join(webDistRoot, 'server/server.js')
  const module = await import(pathToFileURL(serverModulePath).href)
  return module.default as FetchEntry
}

/**
 * Поднимает встроенный HTTP-сервер поверх сборки `@syrnike13/web` (TanStack Start).
 */
export async function startEmbeddedWebServer(
  webDistRoot: string,
  preferredPort = 0,
): Promise<EmbeddedWebServer> {
  const entry = await loadTanStackServer(webDistRoot)

  let listenPort = preferredPort

  const server: Server = createServer(async (req, res) => {
    try {
      const response = await entry.fetch(nodeRequestToFetch(req, listenPort))
      await writeFetchResponse(res, response)
    } catch (error) {
      console.error('[desktop] web server error', error)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'text/plain; charset=utf-8')
      }
      res.end('Internal Server Error')
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(preferredPort, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind embedded web server')
  }

  const port = address.port
  listenPort = port
  const url = `http://127.0.0.1:${port}`

  return {
    url,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
