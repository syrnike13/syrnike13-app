import { createReadStream } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { constants } from 'node:fs'
import { extname, normalize, resolve, sep } from 'node:path'

export type EmbeddedWebServer = {
  url: string
  port: number
  close(): Promise<void>
}

const SPA_SHELL_PATH = '/_shell.html'

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function assetPath(clientDir: string, pathname: string) {
  const decoded = decodeURIComponent(pathname)
  const candidate = resolve(clientDir, `.${normalize(decoded)}`)

  if (candidate !== clientDir && !candidate.startsWith(`${clientDir}${sep}`)) {
    return null
  }

  return candidate
}

function cacheControlFor(pathname: string) {
  if (pathname.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable'
  }

  if (
    pathname === '/sw.js' ||
    pathname === '/serviceWorker.js' ||
    pathname === '/manifest.json' ||
    pathname === '/manifest.webmanifest'
  ) {
    return 'no-store, no-cache, must-revalidate'
  }

  if (pathname === SPA_SHELL_PATH) {
    return 'no-store, no-cache, must-revalidate'
  }

  return 'public, max-age=300'
}

async function serveFile(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  filePath: string,
  pathname: string,
) {
  const file = await stat(filePath)
  if (!file.isFile()) return false

  res.statusCode = 200
  res.setHeader(
    'Content-Type',
    contentTypes[extname(filePath)] ?? 'application/octet-stream',
  )
  res.setHeader('Content-Length', file.size)
  res.setHeader('Cache-Control', cacheControlFor(pathname))

  if (req.method === 'HEAD') {
    res.end()
    return true
  }

  createReadStream(filePath).pipe(res)
  return true
}

async function serveAsset(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  clientDir: string,
  pathname: string,
) {
  const filePath = assetPath(clientDir, pathname)
  if (!filePath) return false

  try {
    return await serveFile(req, res, filePath, pathname)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

async function serveSpaShell(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  clientDir: string,
) {
  const shellFile = assetPath(clientDir, SPA_SHELL_PATH)
  if (!shellFile) return false

  try {
    return await serveFile(req, res, shellFile, SPA_SHELL_PATH)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      throw new Error(
        `SPA shell not found at ${SPA_SHELL_PATH}. Rebuild @syrnike13/web with spa.enabled.`,
      )
    }
    throw error
  }
}

async function ensureSpaShell(clientDir: string) {
  const shellFile = resolve(clientDir, SPA_SHELL_PATH.slice(1))
  await access(shellFile, constants.R_OK)
}

/**
 * Поднимает статический HTTP-сервер для SPA-сборки `@syrnike13/web`.
 */
export async function startEmbeddedWebServer(
  webDistRoot: string,
  preferredPort = 0,
): Promise<EmbeddedWebServer> {
  const clientDir = resolve(webDistRoot, 'client')
  await ensureSpaShell(clientDir)

  let listenPort = preferredPort

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(
        req.url ?? '/',
        `http://${req.headers.host ?? `127.0.0.1:${listenPort}`}`,
      )

      if (await serveAsset(req, res, clientDir, url.pathname)) return

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (await serveSpaShell(req, res, clientDir)) return
      }

      res.statusCode = 404
      res.end('Not Found')
    } catch (error) {
      console.error('[desktop] web server error', error)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'text/plain; charset=utf-8')
      }
      res.end('Internal Server Error')
    }
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(preferredPort, '127.0.0.1', () => resolveListen())
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
      new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()))
      }),
  }
}
