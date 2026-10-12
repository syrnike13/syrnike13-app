import { Effect } from 'effect'

import { getSyrnikeDesktop } from '#/platform/runtime'

export function writeClipboardText(text: string) {
  return Effect.runPromise(writeClipboardTextEffect(text))
}

export const writeClipboardTextEffect = Effect.fn(
  'web.writeClipboardText',
)(function*(text: string) {
  const desktop = getSyrnikeDesktop()
  if (desktop) {
    yield* Effect.tryPromise({
      try: () => desktop.clipboard.writeText(text),
      catch: (cause) => cause,
    })
    return
  }

  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return yield* Effect.fail(new Error('Clipboard API is not available'))
  }

  yield* Effect.tryPromise({
    try: () => navigator.clipboard.writeText(text),
    catch: (cause) => cause,
  })
})
