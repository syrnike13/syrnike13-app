import { useEffect } from 'react'
import { Schema } from 'effect'

import { apiRequest } from '#/lib/api/client'
import type { VoiceStageMediaTrack } from './voice-context'
import { recordDiagnosticEvent } from '#/features/diagnostics/diagnostic-reporter'
import { captureStreamPreview, scheduleStreamPreview } from './stream-preview'

export function useStreamPreviewUpload(
  channelId: string | null,
  token: string | undefined,
  track: VoiceStageMediaTrack | null,
) {
  const backend = track?.backend
  const mediaTrack = track?.track
  useEffect(() => {
    if (!channelId || !token || !track) return
    const abort = new AbortController()
    const report = (error: unknown) => {
      if (abort.signal.aborted) return
      recordDiagnosticEvent(
        'voice',
        'stream_preview_upload_failed',
        {
          message: error instanceof Error ? error.message : String(error),
        },
        { dedupeKey: 'stream-preview-upload', heartbeatMs: 120_000 },
      )
    }
    const schedule = scheduleStreamPreview(async () => {
      const image = await captureStreamPreview(track, abort.signal)
      if (abort.signal.aborted) return
      await apiRequest(
        `/channels/${channelId}/voice/stream-preview`,
        Schema.Void,
        {
          method: 'PUT',
          token,
          body: image,
          signal: abort.signal,
        },
      )
    }, report)
    const ended = () => {
      schedule.stop()
      abort.abort()
    }
    const browserTrack =
      track.backend === 'livekit' ? track.track.mediaStreamTrack : null
    browserTrack?.addEventListener('ended', ended)
    if (browserTrack?.readyState === 'ended') ended()
    else schedule.start()
    return () => {
      ended()
      browserTrack?.removeEventListener('ended', ended)
    }
    // Track wrappers are rebuilt with stage items; only the underlying track owns capture.
  }, [channelId, token, backend, mediaTrack])
}
