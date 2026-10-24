import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat, utimes } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

/** Путь к prerendered SPA shell от TanStack Start (`spa.enabled`). */
export const SPA_SHELL_PATH = '/_shell.html'

/**
 * First-party Activity applications bundled into this image, served to the
 * activity proxy as plain static sites: directory index, no SPA fallback.
 */
export const ACTIVITIES_PATH = '/_activities/'

const contentTypes = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
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

  if (pathname.startsWith(ACTIVITIES_PATH) && extname(pathname) === '.html') {
    return 'no-cache'
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

async function serveAsset(req, res, clientDir, pathname, publicPath = pathname) {
  const filePath = assetPath(clientDir, pathname)
  if (!filePath) return false

  try {
    return await serveFile(req, res, filePath, publicPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Copy this build's hashed assets into a directory that outlives the
 * container, so tabs opened before a deploy can still load lazy chunks of
 * their build. Assets of builds older than `retentionDays` are removed.
 */
export async function archiveAssets({ clientDir, archiveDir, retentionDays }) {
  const assetsDir = resolve(clientDir, 'assets')
  await mkdir(archiveDir, { recursive: true })

  const now = new Date()
  const current = new Set(await readdir(assetsDir))
  for (const name of current) {
    const target = join(archiveDir, name)
    try {
      await stat(target)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await copyFile(join(assetsDir, name), target)
    }
    await utimes(target, now, now)
  }

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  let removed = 0
  for (const name of await readdir(archiveDir)) {
    if (current.has(name)) continue
    const target = join(archiveDir, name)
    const file = await stat(target)
    if (file.isFile() && file.mtimeMs < cutoff) {
      await rm(target)
      removed += 1
    }
  }

  return { archived: current.size, removed }
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
  assetArchiveDir,
  host = '0.0.0.0',
  port = 5000,
}) {
  const resolvedClientDir = resolve(clientDir)
  const resolvedArchiveDir = assetArchiveDir ? resolve(assetArchiveDir) : null
  const shellFile = resolve(resolvedClientDir, SPA_SHELL_PATH.slice(1))

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || `${host}:${port}`}`,
      )

      if (await serveAsset(req, res, resolvedClientDir, url.pathname)) return

      if (url.pathname.startsWith(ACTIVITIES_PATH)) {
        // Directory index for bundled activities; a missing file is a 404,
        // never the app shell.
        const index = `${url.pathname.replace(/\/?$/, '/')}index.html`
        if (await serveAsset(req, res, resolvedClientDir, index)) return
        res.statusCode = 404
        res.end('Not Found')
        return
      }

      if (url.pathname.startsWith('/assets/')) {
        // A missing hashed asset must not fall back to the HTML shell, or the
        // browser fails to parse it as a module.
        const archived =
          resolvedArchiveDir &&
          (await serveAsset(
            req,
            res,
            resolvedArchiveDir,
            url.pathname.slice('/assets'.length),
            url.pathname,
          ))
        if (archived) return
        res.statusCode = 404
        res.end('Not Found')
        return
      }

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
