import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { installStdioPipeErrorHandler } from './stdio-pipe-errors'

function stream() {
  return new EventEmitter() as NodeJS.WriteStream
}

function errorWithCode(code: string) {
  return Object.assign(new Error(code), { code })
}

describe('stdio pipe error handling', () => {
  it('swallows broken pipe errors from closed stdout or stderr pipes', () => {
    const target = stream()
    installStdioPipeErrorHandler(target)

    expect(() => target.emit('error', errorWithCode('EPIPE'))).not.toThrow()
  })

  it('does not swallow non-EPIPE stream errors', () => {
    const target = stream()
    installStdioPipeErrorHandler(target)

    expect(() => target.emit('error', errorWithCode('EINVAL'))).toThrow('EINVAL')
  })

  it('installs at most one handler per stream', () => {
    const target = stream()

    installStdioPipeErrorHandler(target)
    installStdioPipeErrorHandler(target)

    expect(target.listenerCount('error')).toBe(1)
  })
})
