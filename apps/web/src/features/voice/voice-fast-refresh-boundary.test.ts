import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

function runtimeExportNames(source: string) {
  return Array.from(
    source.matchAll(/^export\s+(?!type\b)(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm),
    (match) => match[1],
  )
}

describe('voice provider Fast Refresh boundary', () => {
  it('keeps voice-provider runtime exports component-only', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const source = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(runtimeExportNames(source)).toEqual(['VoiceProvider'])
  })
})
