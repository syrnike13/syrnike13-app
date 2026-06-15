import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, normalize, resolve, sep } from 'node:path'

/** Путь к prerendered SPA shell от TanStack Start (`spa.enabled`). */
export const SPA_SHELL_PATH = '/_shell.html'

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function assetPath(clientDir, pathname) {
  const decoded = decodeURIComponent(pathname)
  const candidate = resolve(clientDir, `.${normalize(decoded)}`)

  if (candidate !== clientDir && !candidate.startsWith(`${clientDir}${sep}`)) {
    return null
  }

  return candidate
}

function cacheControlFor(pathname) {
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

async function serveFile(req, res, filePath, pathname) {
  const file = await stat(filePath)
  if (!file.isFile()) return false

  res.statusCode = 200
  res.setHeader(
    'Content-Type',
    contentTypes[extname(filePath)] || 'application/octet-stream',
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

async function serveAsset(req, res, clientDir, pathname) {
  const filePath = assetPath(clientDir, pathname)
  if (!filePath) return false

  try {
    return await serveFile(req, res, filePath, pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function serveSpaShell(req, res, clientDir) {
  const shellFile = assetPath(clientDir, SPA_SHELL_PATH)
  if (!shellFile) return false

  try {
    return await serveFile(req, res, shellFile, SPA_SHELL_PATH)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `SPA shell not found at ${SPA_SHELL_PATH}. Rebuild @syrnike13/web with spa.enabled.`,
      )
    }
    throw error
  }
}

export function createSpaStaticServer({
  clientDir,
  host = '0.0.0.0',
  port = 5000,
}) {
  const resolvedClientDir = resolve(clientDir)
  const shellFile = resolve(resolvedClientDir, SPA_SHELL_PATH.slice(1))

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || `${host}:${port}`}`,
      )

      if (await serveAsset(req, res, resolvedClientDir, url.pathname)) return

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (await serveSpaShell(req, res, resolvedClientDir)) return
      }

      res.statusCode = 404
      res.end('Not Found')
    } catch (error) {
      console.error('[spa-server] request failed', error)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'text/plain; charset=utf-8')
      }
      res.end('Internal Server Error')
    }
  })

  return {
    server,
    shellFile,
    listen: () =>
      new Promise((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolveListen())
      }),
  }
}
