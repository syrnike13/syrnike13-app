import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, normalize, resolve, sep } from 'node:path'

const port = Number.parseInt(process.env.PORT || '5000', 10)
const distDir = resolve('dist')

const contentTypes = {
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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function assetPath(pathname) {
  const decoded = decodeURIComponent(pathname)
  const candidate = resolve(distDir, `.${normalize(decoded)}`)
  if (candidate !== distDir && !candidate.startsWith(`${distDir}${sep}`)) {
    return null
  }
  return candidate
}

function cacheControlFor(pathname) {
  if (pathname === '/sw.js') {
    return 'no-store, no-cache, must-revalidate'
  }
  if (pathname.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable'
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

async function serveAsset(req, res, pathname) {
  const filePath = assetPath(pathname)
  if (!filePath) return false
  try {
    return await serveFile(req, res, filePath, pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || `0.0.0.0:${port}`}`,
    )

    if (await serveAsset(req, res, url.pathname)) return

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (url.pathname === '/' || url.pathname === '/index.html')
    ) {
      if (await serveAsset(req, res, '/index.html')) return
    }

    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('Not Found')
  } catch (error) {
    console.error('[landing-server] request failed', error)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    }
    res.end('Internal Server Error')
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`syrnike13 landing listening on ${port}`)
})

process.on('SIGTERM', () => {
  server.close()
})
