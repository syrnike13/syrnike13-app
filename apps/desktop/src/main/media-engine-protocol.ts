export type MediaEngineRequestMessage = {
  id: number
  method: string
  params?: unknown
}

export type MediaEngineResponseMessage = {
  id: number
  ok: boolean
  result?: unknown
  error?: {
    code: string
    message: string
  }
}

export type MediaEngineEventMessage = {
  event: string
  params: Record<string, unknown>
}

export function parseMediaEngineLine(
  line: string,
):
  | { kind: 'response'; message: MediaEngineResponseMessage }
  | { kind: 'event'; message: MediaEngineEventMessage }
  | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null

  if ('event' in parsed && typeof parsed.event === 'string') {
    return {
      kind: 'event',
      message: parsed as MediaEngineEventMessage,
    }
  }

  if ('id' in parsed && typeof parsed.id === 'number' && 'ok' in parsed) {
    return {
      kind: 'response',
      message: parsed as MediaEngineResponseMessage,
    }
  }

  return null
}

export function createMediaEngineRequest(
  id: number,
  method: string,
  params: unknown = {},
): string {
  return `${JSON.stringify({ id, method, params } satisfies MediaEngineRequestMessage)}\n`
}
