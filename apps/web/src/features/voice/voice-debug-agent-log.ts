import { env } from '#/env'

export type VoiceDebugAgentPayload = Record<string, unknown> & {
  hypothesis: string
  event: string
}

const VOICE_DEBUG_AGENT_ENDPOINT =
  'http://127.0.0.1:37729/ingest/88f771'

export function logVoiceDebugAgent(payload: VoiceDebugAgentPayload) {
  if (!import.meta.env.DEV) return
  if (import.meta.env.MODE === 'test') return
  // The dedicated RTC diagnostics route is itself an explicit local debug
  // action. Allow it to report to the loopback-only collector without making
  // every dev session opt in globally.
  if (
    env.VITE_VOICE_DEBUG_AGENT !== 'true' &&
    globalThis.location?.pathname !== '/app/voice-debug'
  ) return

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
