import { createReadStream } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { constants } from 'node:fs'
import { extname, normalize, resolve, sep } from 'node:path'
import { Effect } from 'effect'

export type EmbeddedWebServer = {
  url: string
  port: number
  close(): Promise<void>
  closeEffect(): Effect.Effect<void, Error>
}

const SPA_SHELL_PATH = '/_shell.html'

const listen = Effect.fn('desktop.webServer.listen')(
  (server: Server, port: number) =>
    Effect.callback<void, Error>((resume) => {
      const handleError = (error: Error) => {
        server.off('listening', handleListening)
        resume(Effect.fail(error))
      }
      const handleListening = () => {
        server.off('error', handleError)
        resume(Effect.void)
      }

      server.once('error', handleError)
      server.once('listening', handleListening)
      server.listen(port, '127.0.0.1')

      return Effect.sync(() => {
        server.off('error', handleError)
        server.off('listening', handleListening)
      })
    }),
)

const close = Effect.fn('desktop.webServer.close')((server: Server) =>
  Effect.callback<void, Error>((resume) => {
    server.close((error) =>
      resume(error ? Effect.fail(error) : Effect.void),
    )
  }),
)

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

function serveFileEffect(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  filePath: string,
  pathname: string,
) {
  return Effect.gen(function*() {
    const file = yield* Effect.tryPromise({
      try: () => stat(filePath),
      catch: (cause) => cause,
    })
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
  })
}

function serveAssetEffect(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  clientDir: string,
  pathname: string,
) {
  const filePath = assetPath(clientDir, pathname)
  if (!filePath) return Effect.succeed(false)

  return serveFileEffect(req, res, filePath, pathname).pipe(
    Effect.catch((error) =>
      isErrorCode(error, 'ENOENT')
        ? Effect.succeed(false)
        : Effect.fail(error),
    ),
  )
}

function serveSpaShellEffect(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  clientDir: string,
) {
  const shellFile = assetPath(clientDir, SPA_SHELL_PATH)
  if (!shellFile) return Effect.succeed(false)

  return serveFileEffect(req, res, shellFile, SPA_SHELL_PATH).pipe(
    Effect.catch((error) =>
      isErrorCode(error, 'ENOENT')
        ? Effect.fail(
            new Error(
              `SPA shell not found at ${SPA_SHELL_PATH}. Rebuild @syrnike13/web with spa.enabled.`,
            ),
          )
        : Effect.fail(error),
    ),
  )
}

function ensureSpaShellEffect(clientDir: string) {
  const shellFile = resolve(clientDir, SPA_SHELL_PATH.slice(1))
  return Effect.tryPromise({
    try: () => access(shellFile, constants.R_OK),
    catch: (cause) => cause,
  })
}

function isErrorCode(error: unknown, code: string) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function handleRequestEffect(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  clientDir: string,
  listenPort: () => number,
) {
  return Effect.gen(function*() {
    const url = yield* Effect.try({
      try: () =>
        new URL(
          req.url ?? '/',
          `http://${req.headers.host ?? `127.0.0.1:${listenPort()}`}`,
        ),
      catch: (cause) => cause,
    })

    if (yield* serveAssetEffect(req, res, clientDir, url.pathname)) return

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (yield* serveSpaShellEffect(req, res, clientDir))
    ) {
      return
    }

    res.statusCode = 404
    res.end('Not Found')
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error('[desktop] web server error', error)
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('content-type', 'text/plain; charset=utf-8')
        }
        res.end('Internal Server Error')
      }),
    ),
  )
}

/**
 * Поднимает статический HTTP-сервер для SPA-сборки `@syrnike13/web`.
 */
export const startEmbeddedWebServerEffect = Effect.fn(
  'desktop.webServer.start',
)(function*(webDistRoot: string, preferredPort = 0) {
  const clientDir = resolve(webDistRoot, 'client')
  yield* ensureSpaShellEffect(clientDir)

  let listenPort = preferredPort
  const server: Server = createServer((req, res) => {
    Effect.runFork(
      handleRequestEffect(req, res, clientDir, () => listenPort),
    )
  })

  yield* listen(server, preferredPort)

  const address = server.address()
  if (!address || typeof address === 'string') {
    return yield* Effect.fail(new Error('Failed to bind embedded web server'))
  }

  const port = address.port
  listenPort = port
  const url = `http://127.0.0.1:${port}`
  const closeEffect = () => close(server)

  return {
    url,
    port,
    close: () => Effect.runPromise(closeEffect()),
    closeEffect,
  }
})

export function startEmbeddedWebServer(
  webDistRoot: string,
  preferredPort = 0,
): Promise<EmbeddedWebServer> {
  return Effect.runPromise(
    startEmbeddedWebServerEffect(webDistRoot, preferredPort),
  )
}
