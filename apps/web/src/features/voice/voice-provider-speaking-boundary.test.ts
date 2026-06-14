import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

function readVoiceProviderSource() {
  const repoRoot = resolve(
    fileURLToPath(new URL('../../../../..', import.meta.url)),
  )
  return readFileSync(
    resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
    'utf8',
  )
}

describe('voice provider speaking boundary', () => {
  it('does not reference the removed single-source speaking setter', () => {
    const source = readVoiceProviderSource()
    expect(source).not.toContain('setSpeakingUserIdsIfChanged')
  })

  it('keeps stale native screen ended callbacks from clearing a newer session', () => {
    const source = readVoiceProviderSource()

    expect(source).toContain('if (!active || active !== session) return')
  })
})
