import { lazy, Suspense, useCallback } from 'react'

import { writeClipboardText } from '#/lib/clipboard'
import { getSyrnikeRuntime, isDesktopRuntime } from '#/platform/runtime'

const Agentation = import.meta.env.DEV
  ? lazy(() =>
      import('agentation').then((module) => ({
        default: module.Agentation,
      })),
    )
  : null

/** Visual annotation toolbar for AI agents — only mounted in Vite DEV. */
export function AgentationDevtools() {
  if (!Agentation) return null

  return (
    <Suspense fallback={null}>
      <AgentationWithAppClipboard />
    </Suspense>
  )
}

function AgentationWithAppClipboard() {
  const AgentationComponent = Agentation!
  const handleCopy = useCallback(async (markdown: string) => {
    const runtime = getSyrnikeRuntime()
    const desktop = isDesktopRuntime()
    let writeOk = false
    let writeError: string | null = null

    try {
      await writeClipboardText(markdown)
      writeOk = true
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error)
    }

    // #region debug log
    fetch('http://127.0.0.1:58862/ingest/512fd5', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: '512fd5',
        runId: 'post-fix',
        hypothesisId: 'A',
        location: 'agentation-devtools.tsx:onCopy',
        message: 'Agentation copy via writeClipboardText',
        data: {
          runtime,
          desktop,
          writeOk,
          writeError,
          markdownLength: markdown.length,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {})
    // #endregion
  }, [])

  return (
    <AgentationComponent
      copyToClipboard={false}
      onCopy={handleCopy}
    />
  )
}
