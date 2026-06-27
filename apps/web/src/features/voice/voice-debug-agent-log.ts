import { env } from '#/env'

type VoiceDebugAgentPayload = Record<string, unknown> & {
  hypothesis: string
  event: string
}

const VOICE_DEBUG_AGENT_ENDPOINT =
  'http://127.0.0.1:37729/ingest/88f771'

export function logVoiceDebugAgent(payload: VoiceDebugAgentPayload) {
  if (!import.meta.env.DEV) return
  if (import.meta.env.MODE === 'test') return
  if (env.VITE_VOICE_DEBUG_AGENT !== 'true') return

  // #region debug log
  void fetch(VOICE_DEBUG_AGENT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      area: 'voice-media-slice',
      timestamp: Date.now(),
      ...payload,
    }),
  }).catch(() => {})
  // #endregion
}
