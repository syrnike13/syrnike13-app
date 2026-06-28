const INSTALLED_KEY = Symbol.for('syrnike13.stdioPipeErrorHandlerInstalled')

type StdioStream = NodeJS.WriteStream & {
  [INSTALLED_KEY]?: true
}

function isBrokenPipeError(error: unknown) {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'EPIPE'
  )
}

export function installStdioPipeErrorHandler(stream: NodeJS.WriteStream) {
  const target = stream as StdioStream
  if (target[INSTALLED_KEY]) return
  target[INSTALLED_KEY] = true

  target.on('error', (error) => {
    if (isBrokenPipeError(error)) return
    throw error
  })
}

export function installStdioPipeErrorHandlers() {
  installStdioPipeErrorHandler(process.stdout)
  installStdioPipeErrorHandler(process.stderr)
}
