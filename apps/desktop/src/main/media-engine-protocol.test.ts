import { describe, expect, it } from 'vitest'

import {
  createMediaEngineRequest,
  parseMediaEngineLine,
} from './media-engine-protocol'

describe('media-engine protocol', () => {
  it('creates request lines', () => {
    expect(createMediaEngineRequest(3, 'engine.ping', {})).toBe(
      '{"id":3,"method":"engine.ping","params":{}}\n',
    )
  })

  it('parses success responses', () => {
    const parsed = parseMediaEngineLine(
      '{"id":1,"ok":true,"result":{"version":"0.1.0","engine":"syrnike-media-engine","livekit":true}}',
    )

    expect(parsed?.kind).toBe('response')
    if (parsed?.kind !== 'response') return

    expect(parsed.message.ok).toBe(true)
    expect(parsed.message.result).toEqual({
      version: '0.1.0',
      engine: 'syrnike-media-engine',
      livekit: true,
    })
  })

  it('parses push events', () => {
    const parsed = parseMediaEngineLine(
      '{"event":"engine.ready","params":{"version":"0.1.0","engine":"syrnike-media-engine","pipe":"syrnike-media-42"}}',
    )

    expect(parsed?.kind).toBe('event')
    if (parsed?.kind !== 'event') return

    expect(parsed.message.event).toBe('engine.ready')
    expect(parsed.message.params.pipe).toBe('syrnike-media-42')
  })
})
