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

  it('guards native screen share starts against stale voice sessions', () => {
    const source = readVoiceProviderSource()

    expect(source).toContain('const screenShareStartGenerationRef = useRef(0)')
    expect(source.match(/screenShareStartGenerationRef\.current \+= 1/g)).toHaveLength(2)
    expect(source).toContain('const screenShareStartingRef = useRef(false)')
    expect(source).toContain('if (screenShareStartingRef.current || nativeScreenShareRef.current) return')
    expect(source).toContain('screenShareStartingRef.current = true')
    expect(source).toContain('const isCurrentScreenShareStart = () =>')
    expect(source).toContain('const clearCurrentScreenShareStart = () =>')
    expect(source).toContain('if (!isCurrentScreenShareStart())')
    expect(source).toContain('await session.stop().catch(() => {})')
    expect(source).toContain("desktop.media.cancelPendingStarts('screen')")
  })

  it('guards local voice setup against stale room completions', () => {
    const source = readVoiceProviderSource()

    expect(source).toContain(
      'if (!nativeStarted || !isCurrentVoiceSession(room, targetChannelId))',
    )
    expect(source).toContain('setLocalVoiceReady(true)')
    expect(source).toContain("setConnectionPhase('connected')")
  })

  it('defers native screen share starts until local voice setup is ready', () => {
    const source = readVoiceProviderSource()

    expect(source).toContain('const localVoiceReadyRef = useRef(false)')
    expect(source).toContain('localVoiceReadyRef.current = localVoiceReady')
    expect(source).toContain('const pendingScreenShareStartRef = useRef')
    expect(source).toContain('pendingScreenShareStartRef.current = { quality, withAudio }')
    expect(source).toContain('screen-start-deferred-local-voice-not-ready')
    expect(source).toContain('screen-start-resumed-after-local-voice-ready')
    expect(source).toContain('void startLocalScreenShare(pending.quality, pending.withAudio)')
    expect(source.match(/pendingScreenShareStartRef\.current = null/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('does not mark native screen share active from the helper ref alone', () => {
    const source = readVoiceProviderSource()

    expect(source).not.toContain(
      'localMedia.screensharing || Boolean(nativeScreenShareRef.current)',
    )
    expect(source).toContain('findNativeScreenPublication')
    expect(source).toContain('nativeMediaReducer')
    expect(source).toContain('isNativeScreenPublished(nativeMediaState)')
  })

  it('keeps native media coordinator ref in sync before room resyncs', () => {
    const source = readVoiceProviderSource()

    expect(source).toContain('const nativeMediaStateRef = useRef(nativeMediaState)')
    expect(source).toContain(
      'nativeMediaStateRef.current = nativeMediaReducer(',
    )
    expect(source).toContain(
      'isNativeScreenPublished(nativeMediaStateRef.current)',
    )
  })

  it('cleans up native screen state when the LiveKit publication disappears', () => {
    const source = readVoiceProviderSource()

    expect(source).toContain('native-screen-publication-lost')
    expect(source).toContain('RoomEvent.ParticipantDisconnected')
    expect(source).toContain('RoomEvent.TrackUnpublished')
    expect(source).toContain("reason: 'publication-missing'")
    expect(source).toContain("dispatchNativeMedia({ type: 'screen_stopped' })")
  })

  it('cleans native screen state and session-machine state on unexpected room disconnect', () => {
    const source = readVoiceProviderSource()
    const disconnectBlock =
      source.match(
        /room\.on\(RoomEvent\.Disconnected[\s\S]*?voiceRejoinRef\.current\.onUnexpectedDisconnect\(targetChannelId\)[\s\S]*?\}\)/,
      )?.[0] ?? ''

    expect(disconnectBlock).toContain(
      'voiceSessionControllerRef.current.handleRoomDisconnected',
    )
    expect(disconnectBlock).toContain('disconnectNativeMediaForHandoff()')
    expect(source).toContain('screenShareStartGenerationRef.current += 1')
    expect(source).toContain('pendingScreenShareStartRef.current = null')
    expect(source).toContain('nativeScreenShareRef.current')
    expect(source).toContain("dispatchNativeMedia({ type: 'screen_stopped' })")
  })
})
