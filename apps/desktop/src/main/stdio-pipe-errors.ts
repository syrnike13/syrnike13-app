import { Option, Schema } from 'effect'

const installedStreams = new WeakSet<NodeJS.WriteStream>()
const BrokenPipeErrorSchema = Schema.Struct({
  code: Schema.Literal('EPIPE'),
})

function isBrokenPipeError(error: unknown) {
  return (
    error instanceof Error &&
    Option.isSome(
      Schema.decodeUnknownOption(BrokenPipeErrorSchema)(error),
    )
  )
}

export function installStdioPipeErrorHandler(stream: NodeJS.WriteStream) {
  if (installedStreams.has(stream)) return
  installedStreams.add(stream)

  stream.on('error', (error) => {
    if (isBrokenPipeError(error)) return
    throw error
  })
}

export function installStdioPipeErrorHandlers() {
  installStdioPipeErrorHandler(process.stdout)
  installStdioPipeErrorHandler(process.stderr)
}
