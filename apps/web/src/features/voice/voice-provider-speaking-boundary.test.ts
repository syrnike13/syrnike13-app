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

function readVoiceStageMediaSyncSource() {
  const repoRoot = resolve(
    fileURLToPath(new URL('../../../../..', import.meta.url)),
  )
  return readFileSync(
    resolve(repoRoot, 'apps/web/src/features/voice/voice-stage-media-sync.ts'),
    'utf8',
  )
}

function readVoiceLocalSetupSource() {
  const repoRoot = resolve(
    fileURLToPath(new URL('../../../../..', import.meta.url)),
  )
  return readFileSync(
    resolve(repoRoot, 'apps/web/src/features/voice/voice-local-setup.ts'),
    'utf8',
  )
}

function readVoiceNativeMediaSource() {
  const repoRoot = resolve(
    fileURLToPath(new URL('../../../../..', import.meta.url)),
  )
  return readFileSync(
    resolve(repoRoot, 'apps/web/src/features/voice/voice-native-media.ts'),
    'utf8',
  )
}

function readVoiceRoomAudioSource() {
  const repoRoot = resolve(
    fileURLToPath(new URL('../../../../..', import.meta.url)),
  )
  return readFileSync(
    resolve(repoRoot, 'apps/web/src/features/voice/voice-room-audio.ts'),
    'utf8',
  )
}

function readVoiceScreenShareSource() {
  const repoRoot = resolve(
    fileURLToPath(new URL('../../../../..', import.meta.url)),
  )
  return readFileSync(
    resolve(repoRoot, 'apps/web/src/features/voice/voice-screen-share.ts'),
    'utf8',
  )
}

describe('voice provider speaking boundary', () => {
  it('does not reference the removed single-source speaking setter', () => {
    const source = readVoiceProviderSource()
    expect(source).not.toContain('setSpeakingUserIdsIfChanged')
  })

  it('keeps stale native screen ended callbacks from clearing a newer session', () => {
    const screenShareSource = readVoiceScreenShareSource()

    expect(screenShareSource).toContain('if (!active || active !== session) return')
  })

  it('guards native screen share starts against stale voice sessions', () => {
    const source = readVoiceProviderSource()
    const nativeMediaSource = readVoiceNativeMediaSource()
    const screenShareSource = readVoiceScreenShareSource()

    expect(source).toContain('const screenShareStartGenerationRef = useRef(0)')
    expect(
      nativeMediaSource.match(/screenShareStartGenerationRef\.current \+= 1/g),
    ).toHaveLength(1)
    expect(source.match(/resetNativeMediaState\(\{/g)).toHaveLength(1)
    expect(source).toContain('disconnectNativeMediaForHandoffFromDeps({')
    expect(nativeMediaSource).toContain('resetStatsWithoutActiveScreen: true')
    expect(source).toContain('const screenShareStartingRef = useRef(false)')
    expect(screenShareSource).toContain(
      'deps.screenShareStartingRef.current || deps.nativeScreenShareRef.current',
    )
    expect(screenShareSource).toContain('deps.screenShareStartingRef.current = true')
    expect(screenShareSource).toContain('const isCurrentScreenShareStart = () =>')
    expect(screenShareSource).toContain('const clearCurrentScreenShareStart = () =>')
    expect(screenShareSource).toContain('if (!isCurrentScreenShareStart())')
    expect(screenShareSource).toContain('Promise.resolve(session.stop())')
    expect(screenShareSource).toContain("desktop.media.cancelPendingStarts('screen')")
  })

  it('guards local voice setup against stale room completions', () => {
    const source = readVoiceProviderSource()
    const localSetupSource = readVoiceLocalSetupSource()

    expect(source).toContain('finishLocalVoiceSetup as finishLocalVoiceSetupFromDeps')
    expect(source).toContain('isCurrentVoiceSession,')
    expect(localSetupSource).toContain(
      'if (!nativeStarted || !deps.isCurrentVoiceSession(room, targetChannelId))',
    )
    expect(localSetupSource).toContain('setLocalVoiceReady(true)')
    expect(localSetupSource).toContain("setConnectionPhase('connected')")
  })

  it('defers native screen share starts until local voice setup is ready', () => {
    const source = readVoiceProviderSource()
    const nativeMediaSource = readVoiceNativeMediaSource()
    const screenShareSource = readVoiceScreenShareSource()

    expect(source).toContain('const localVoiceReadyRef = useRef(false)')
    expect(source).toContain('localVoiceReadyRef.current = localVoiceReady')
    expect(source).toContain('const pendingScreenShareStartRef = useRef')
    expect(screenShareSource).toContain('deps.pendingScreenShareStartRef.current = {')
    expect(screenShareSource).toContain('screen-start-deferred-local-voice-not-ready')
    expect(source).toContain('screen-start-resumed-after-local-voice-ready')
    expect(source).toContain('void startLocalScreenShare(pending.quality, pending.withAudio)')
    expect(
      [
        ...(source.match(/pendingScreenShareStartRef\.current = null/g) ?? []),
        ...(nativeMediaSource.match(
          /pendingScreenShareStartRef\.current = null/g,
        ) ?? []),
        ...(screenShareSource.match(
          /pendingScreenShareStartRef\.current = null/g,
        ) ?? []),
      ].length,
    ).toBeGreaterThanOrEqual(3)
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
    const stageMediaSyncSource = readVoiceStageMediaSyncSource()

    expect(source).toContain('const nativeMediaStateRef = useRef(nativeMediaState)')
    expect(source).toContain(
      'nativeMediaStateRef.current = nativeMediaReducer(',
    )
    expect(source).toContain('nativeMediaState: nativeMediaStateRef.current')
    expect(source).toContain(
      'syncRoomParticipants as syncRoomParticipantsForRoom',
    )
    expect(stageMediaSyncSource).toContain(
      'isNativeScreenPublished(options.nativeMediaState)',
    )
  })

  it('cleans up native screen state when the LiveKit publication disappears', () => {
    const source = readVoiceProviderSource()
    const stageMediaSyncSource = readVoiceStageMediaSyncSource()
    const screenShareSource = readVoiceScreenShareSource()
    const roomAudioSource = readVoiceRoomAudioSource()

    expect(screenShareSource).toContain('native-screen-publication-lost')
    expect(roomAudioSource).toContain('RoomEvent.ParticipantDisconnected')
    expect(roomAudioSource).toContain('RoomEvent.TrackUnpublished')
    expect(stageMediaSyncSource).toContain("reason: 'publication-missing'")
    expect(source).toContain('onNativeScreenPublicationLost')
    expect(screenShareSource).toContain(
      "dispatchNativeMedia({ type: 'screen_stopped' })",
    )
  })

  it('cleans native screen state and session-machine state on unexpected room disconnect', () => {
    const source = readVoiceProviderSource()
    const nativeMediaSource = readVoiceNativeMediaSource()
    const roomAudioSource = readVoiceRoomAudioSource()
    const disconnectBlock =
      source.match(
        /onUnexpectedRoomDisconnect[\s\S]*?setConnectionPhase\('reconnecting'\)[\s\S]*?\}/,
      )?.[0] ?? ''

    expect(roomAudioSource).toContain('RoomEvent.Disconnected')
    expect(disconnectBlock).toMatch(
      /voiceIntentExecutorRef\.current\.onRoomDisconnected\(\s*false,\s*'Room disconnected',?\s*\)/,
    )
    expect(disconnectBlock).not.toContain('voiceRejoinRef')
    expect(disconnectBlock).not.toContain(
      'voiceSessionControllerRef.current.handleRoomDisconnected',
    )
    expect(disconnectBlock).toContain('disconnectNativeMediaForHandoff()')
    expect(source).toContain('resetNativeMediaState({')
    expect(nativeMediaSource).toContain('screenShareStartGenerationRef.current += 1')
    expect(nativeMediaSource).toContain('pendingScreenShareStartRef.current = null')
    expect(nativeMediaSource).toContain('nativeScreenShareRef.current')
    expect(readVoiceScreenShareSource()).toContain(
      "dispatchNativeMedia({ type: 'screen_stopped' })",
    )
  })

  it('starts Phase D wiring through VoiceIntentExecutor without a second operation source', () => {
    const source = readVoiceProviderSource()

    expect(source).toContain('createVoiceIntentExecutor')
    expect(source).toContain('voiceIntentActionFromGatewayEvent')
    expect(source).toMatch(
      /voiceIntentExecutorRef\.current\.intent\(targetChannelId, reason\)/,
    )
    expect(source).toMatch(
      /const action = voiceIntentActionFromGatewayEvent\(event, auth\.user\?\._id\)[\s\S]*voiceIntentExecutorRef\.current\.observeCommit\(action\.operationId, action\.channelId\)/,
    )
    expect(source).not.toContain('pendingVoiceIntentOperationIdRef')
    expect(source).not.toMatch(
      /voiceSessionControllerRef\.current\.requestJoin\([\s\S]*pendingVoiceIntentOperationIdRef[\s\S]*voiceIntentExecutorRef\.current\.intent\(targetChannelId, reason\)/,
    )
    expect(source).not.toContain('voiceCommitFromGatewayEvent')
    expect(source).not.toContain('voiceCommitOperationIdToObserve')
  })

  it('routes public leave through VoiceIntentExecutor clearIntent', () => {
    const source = readVoiceProviderSource()

    expect(source).toMatch(
      /const leave = useCallback\(\(\) => \{[\s\S]*voiceIntentExecutorRef\.current\.clearIntent\(\)[\s\S]*\},/,
    )
    expect(source).not.toContain('rememberVoiceIntentCanceledOperation')
    expect(source).not.toMatch(
      /const leave = useCallback\(\(\) => \{[\s\S]*leaveVoiceSession\('leave'\)/,
    )
    expect(source).not.toMatch(
      /const leave = useCallback\(\(\) => \{[\s\S]*voiceSessionControllerRef\.current\.requestLeave\(\)/,
    )
  })

  it('keeps gateway subscription as direct commit and leave mapping', () => {
    const source = readVoiceProviderSource()

    expect(source).toMatch(
      /voiceIntentActionFromGatewayEvent\(event, auth\.user\?\._id\)[\s\S]*voiceIntentExecutorRef\.current\.observeCommit\(action\.operationId, action\.channelId\)/,
    )
    expect(source).toMatch(
      /action\?\.type === 'leave_observed'[\s\S]*voiceIntentExecutorRef\.current\.observeLeave\(action\.operationId\)/,
    )
    expect(source).toContain(
      'disconnectLocalSession: async ({ channelId: leftChannelId, room })',
    )
    expect(source).not.toContain('voiceIntentSupersedeFromGatewayEvent')
    expect(source).not.toMatch(
      /eventsGateway\.subscribeEvents[\s\S]*observeSupersede\(/,
    )
    expect(source).not.toContain('remoteVoiceSupersedeInFlightRef')
    expect(source).not.toContain('stopRemoteSupersededVoiceSession')
    expect(source).not.toContain('voiceSessionControllerRef.current.requestLeave')
    expect(source).not.toContain(
      'voiceSessionControllerRef.current.handleRoomDisconnected',
    )
    expect(source).not.toContain('leaveVoiceSessionRef')
  })

  it('keeps room assignment ownership inside VoiceIntentExecutor', () => {
    const source = readVoiceProviderSource()

    expect(source).not.toContain('setActiveRoom')
    expect(source).toMatch(/onRoomChanged: \(room\) => \{[\s\S]*roomRef\.current = room/)
  })

  it('delegates recovery desired channel ownership to VoiceIntentExecutor', () => {
    const source = readVoiceProviderSource()

    expect(source).toContain('voiceIntentExecutorRef.current.reconcileWithServer')
    expect(source).not.toContain('getDesiredChannelId: () => {')
    expect(source).not.toContain('voiceSessionControllerRef.current.getState()')
  })

  it('keeps planned disconnect state out of the provider and room audio wiring', () => {
    const providerSource = readVoiceProviderSource()
    const roomAudioSource = readVoiceRoomAudioSource()

    expect(providerSource).not.toContain('disconnectIntentRef')
    expect(providerSource).not.toContain('type DisconnectIntent')
    expect(roomAudioSource).not.toContain('getDisconnectIntent')
    expect(roomAudioSource).not.toContain('clearDisconnectIntent')
  })

  it('keeps voice transition rate-limit attempt storage outside the provider', () => {
    const source = readVoiceProviderSource()

    expect(source).toContain('createVoiceTransitionRateLimiter')
    expect(source).not.toContain('voiceTransitionAttemptsRef')
  })

  it('does not own recovery rejoin backoff or create rejoin operations in the provider', () => {
    const source = readVoiceProviderSource()

    expect(source).not.toContain('requestRejoinOperation:')
    expect(source).not.toContain('createVoiceRejoinController')
    expect(source).not.toContain('VoiceRejoinControllerOptions')
    expect(source).not.toContain('voiceRejoinRef')
    expect(source).not.toContain('voiceRejoinDepsRef')
    expect(source).not.toContain('recoveryJoinInFlightRef')
    expect(source).not.toContain('attemptRejoin: (channelId) =>')
    expect(source).not.toContain('voiceSessionControllerRef.current.requestJoin')
  })

  it('does not construct the legacy session controller in the provider', () => {
    const source = readVoiceProviderSource()

    expect(source).not.toContain('createVoiceSessionController')
    expect(source).not.toContain('voiceSessionControllerRef')
  })

  it('preserves executor rejoin reason when invoking the join runner', () => {
    const source = readVoiceProviderSource()

    expect(source).toMatch(
      /performVoiceJoin: \(targetChannelId, options\) =>[\s\S]*performVoiceJoinRef\.current\(targetChannelId, \{[\s\S]*operationId: options\.operationId,[\s\S]*rejoin: options\.reason === 'rejoin',[\s\S]*\}\)/,
    )
  })

  it('keeps join runner recency checks on the shared active operation reader', () => {
    const source = readVoiceProviderSource()
    const joinDepsBlock =
      source.match(
        /voiceJoinDepsRef\.current = \{[\s\S]*?voiceIntentExecutorDepsRef\.current = \{/,
      )?.[0] ?? ''

    expect(joinDepsBlock).toContain('getActiveVoiceOperationId() === operationId')
    expect(joinDepsBlock).not.toContain('voiceSessionControllerRef.current.getState()')
  })

  it('does not mirror join runner phases into the legacy session controller', () => {
    const source = readVoiceProviderSource()

    expect(source).not.toContain(
      'voiceSessionControllerRef.current.handleServerPrepareSucceeded',
    )
    expect(source).not.toContain(
      'voiceSessionControllerRef.current.handleRoomConnected',
    )
    expect(source).not.toContain(
      'voiceSessionControllerRef.current.handleRoomConnectFailed',
    )
  })
})
