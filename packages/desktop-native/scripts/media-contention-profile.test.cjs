const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
  releaseAfterRendererFence,
} = require('./media-contention-renderer-fence.cjs')

const {
  buildContentionArtifact,
  contentionProbeRestartDelayMs,
  evaluateContentionRun,
  linkedVideoReadyDeadlineMs,
  resolveContentionProfile,
} = require('./media-contention-profile.cjs')
const {
  mintLocalLiveKitSession,
} = require('./media-contention-livekit.cjs')
const {
  BoundedSampleWindow,
  buildContentionWindowOptions,
  buildLocalLiveKitServerArguments,
  canonicalizeAudioPipeline,
  buildRemoteAudioPlayoutMetrics,
  buildDistributionMetrics,
  canonicalizeVideoPipeline,
  classifyNativeProbeStderr,
  classifyRuntimeFrameEpoch,
  contentionCompletionBlockers,
  contentionCompletionDeadlineMs,
  contentionProbeDurationMs,
  isRetiredRendererRelease,
  isBridgeSkippedRetiredRelease,
  isCorrelatedInjectedRetirement,
  assignContentionRecoveryEpochs,
  contentionObservationElapsedMs,
  trackPendingOperation,
  contentionPageDataUrl,
  hasLinkedVideoPresentation,
  mediaPriorityPolicyEnvironment,
  parseRunnerOptions,
  parsePrefixedJson,
  parseLiveKitJoinToken,
  startContentionWindowMotion,
  selectLatestAudioEvidence,
  selectResourceBaselineSummaries,
  resourceBaselinesComplete,
  shutdownChildren,
  shouldInjectRemoteRendererFence,
  shouldAwaitResourceBaseline,
} = require('./media-contention-runner.cjs')

test('contention animation remains visible to Desktop Duplication', () => {
  const options = buildContentionWindowOptions('preload.cjs')
  assert.equal(options.show, true)
  assert.equal(options.alwaysOnTop, true)
  assert.equal(options.focusable, false)
  assert.equal(options.webPreferences.preload, 'preload.cjs')
})

test('competing workload waits for exact linked video presentation', () => {
  const candidates = new Map()
  assert.equal(hasLinkedVideoPresentation(candidates), false)
  candidates.set('1', {
    captureFrameId: '1',
    encodedFrameId: '1',
    publicationFrameId: '1',
    remoteFrameId: '1',
    electronFrameId: '1',
    nativeCaptureTimestampUs: 123,
    remoteCaptureTimestampUs: 123,
  })
  assert.equal(hasLinkedVideoPresentation(candidates), true)
  candidates.get('1').remoteCaptureTimestampUs = 124
  assert.equal(hasLinkedVideoPresentation(candidates), false)
})

test('frames arriving between protocol ready and supervisor ready wait for epoch activation', () => {
  assert.equal(classifyRuntimeFrameEpoch(1, 0), 'pending')
  assert.equal(classifyRuntimeFrameEpoch(1, 1), 'current')
  assert.equal(classifyRuntimeFrameEpoch(1, 2), 'retired')
  assert.equal(classifyRuntimeFrameEpoch(0, 0), 'invalid')
})

test('renderer fault keeps one delivery slot open until native pool rollover', () => {
  assert.equal(shouldInjectRemoteRendererFence(0, 0), true)
  assert.equal(shouldInjectRemoteRendererFence(1, 0), true)
  assert.equal(shouldInjectRemoteRendererFence(2, 0), false)
  assert.equal(shouldInjectRemoteRendererFence(2, 1), true)
  assert.equal(shouldInjectRemoteRendererFence(3, 1), false)
})

test('camera preview frames and acknowledgements cross the child protocol parser', () => {
  assert.deepEqual(parsePrefixedJson(
    'CAMERA_FRAME {"protocolVersion":1,"sequence":7}',
  ), {
    prefix: 'CAMERA_FRAME',
    value: { protocolVersion: 1, sequence: 7 },
  })
  assert.deepEqual(parsePrefixedJson(
    'CAMERA_RELEASE_ACK {"protocolVersion":1,"requestId":8}',
  ), {
    prefix: 'CAMERA_RELEASE_ACK',
    value: { protocolVersion: 1, requestId: 8 },
  })
})

test('linked screen pipeline stays within the server screenshare preset', () => {
  const record = {
    protocolVersion: 1,
    roomName: 'issue83-local',
    publisherIdentity: 'publisher',
    viewerIdentity: 'viewer',
    publicationSid: 'TR_screen',
    remoteTrackSid: 'TR_screen',
    publicationWidth: 1_920,
    publicationHeight: 1_080,
  }
  assert.deepEqual(canonicalizeVideoPipeline(record), {
    roomName: 'issue83-local',
    publisherIdentity: 'publisher',
    viewerIdentity: 'viewer',
    publicationSid: 'TR_screen',
    remoteTrackSid: 'TR_screen',
    publicationWidth: 1_920,
    publicationHeight: 1_080,
  })
  assert.equal(canonicalizeVideoPipeline({
    ...record,
    publicationWidth: 2_560,
    publicationHeight: 1_440,
  }), null)
})

test('audio pipeline canonicalizes a republished local SID before correlation', () => {
  const pipeline = canonicalizeAudioPipeline({
    protocolVersion: 1,
    publisherIdentity: 'publisher',
    viewerIdentity: 'viewer',
    publishReturnSid: 'TR_provisional',
    localPublicationSid: 'TR_canonical',
    remotePublicationSid: 'TR_canonical',
    remoteTrackSid: 'TR_canonical',
  })
  assert.deepEqual(pipeline, {
    publisherIdentity: 'publisher',
    viewerIdentity: 'viewer',
    publicationSid: 'TR_canonical',
    remoteTrackSid: 'TR_canonical',
  })
  assert.deepEqual(buildRemoteAudioPlayoutMetrics([{
    protocolVersion: 1,
    audioTrackId: 'contention-audio',
    audioIngressFrames: 805,
    audioRendererFillCallbacks: 808,
    audioRenderedTrackFrames: 381_022,
    audioInjectedWakeGaps: 4,
    audioRecoveredWakeGaps: 4,
    audioTrackFailures: 0,
    ...pipeline,
  }]), {
    protocolVersion: 1,
    trackId: 'contention-audio',
    ingressFrames: 805,
    rendererFillCallbacks: 808,
    renderedSamples: 762_044,
    injectedWakeGaps: 4,
    recoveredWakeGaps: 4,
    trackFailures: 0,
    linkedRoomEpochs: 1,
  })
  assert.equal(canonicalizeAudioPipeline({
    protocolVersion: 1,
    publisherIdentity: 'publisher',
    viewerIdentity: 'viewer',
    publishReturnSid: 'TR_provisional',
    localPublicationSid: 'TR_canonical',
    remotePublicationSid: 'TR_other',
    remoteTrackSid: 'TR_other',
  }), null)
})

test('runner defines an owned loopback LiveKit server with isolated random ports', () => {
  assert.deepEqual(buildLocalLiveKitServerArguments({
    httpPort: 41_001,
    tcpPort: 41_002,
    udpPort: 41_003,
  }), [
    '--dev',
    '--bind', '127.0.0.1',
    '--port', '41001',
    '--udp-port', '41003',
    '--rtc.tcp_port', '41002',
  ])
  assert.equal(
    parseLiveKitJoinToken('Token: header.payload.signature\r\n'),
    'header.payload.signature',
  )
  assert.throws(
    () => parseLiveKitJoinToken('token missing'),
    /join token/i,
  )
})

test('LiveKit session minting requests a join token for every publisher and viewer epoch', async () => {
  const commands = []
  const session = await mintLocalLiveKitSession('livekit-server.exe', {
    roomName: 'room-a',
    runChild: async (executable, args) => {
      commands.push([executable, ...args])
      return { stdout: `Token: token-${args.at(-1)}\n` }
    },
  })

  assert.equal(session.roomName, 'room-a')
  assert.equal(session.participants.length, 16)
  assert.equal(commands.length, 32)
  assert.deepEqual(commands[0], [
    'livekit-server.exe',
    '--dev',
    'create-join-token',
    '--room',
    'room-a',
    '--identity',
    'contention-publisher-1',
  ])
  assert.equal(
    session.participants[0].publisherToken,
    'token-contention-publisher-1',
  )
  assert.equal(
    session.participants[15].viewerToken,
    'token-contention-viewer-16',
  )
})

test('contention runner accepts a pre-minted LiveKit participants file', () => {
  const parsed = parseRunnerOptions([
    '--livekit-room',
    'issue83-test',
    '--livekit-participants-file',
    'participants.json',
    '--contention-started-file',
    'started.flag',
  ])
  assert.equal(parsed.liveKitRoom, 'issue83-test')
  assert.equal(parsed.liveKitParticipantsFile, 'participants.json')
  assert.equal(parsed.contentionStartedFile, 'started.flag')
})

test('runner retains the latest real audio evidence from every recycled probe epoch', () => {
  const selected = selectLatestAudioEvidence([
    {
      hostEpoch: 1,
      evidenceSequence: 1,
      protocolVersion: 1,
      audioTrackId: 'contention-audio',
      audioIngressFrames: 10,
      audioRendererFillCallbacks: 8,
      audioRenderedTrackFrames: 960,
      audioInjectedWakeGaps: 1,
      audioRecoveredWakeGaps: 1,
      audioTrackFailures: 0,
      normalAudioAgeSampleCount: 100,
      normalAudioAgeP95Us: 21_000,
      normalAudioAgeP99Us: 31_000,
    },
    {
      hostEpoch: 1,
      evidenceSequence: 2,
      protocolVersion: 1,
      audioTrackId: 'contention-audio',
      audioIngressFrames: 20,
      audioRendererFillCallbacks: 16,
      audioRenderedTrackFrames: 1_920,
      audioInjectedWakeGaps: 2,
      audioRecoveredWakeGaps: 2,
      audioTrackFailures: 0,
      normalAudioAgeSampleCount: 200,
      normalAudioAgeP95Us: 22_000,
      normalAudioAgeP99Us: 32_000,
    },
    {
      hostEpoch: 2,
      evidenceSequence: 1,
      protocolVersion: 1,
      audioTrackId: 'contention-audio',
      audioIngressFrames: 30,
      audioRendererFillCallbacks: 24,
      audioRenderedTrackFrames: 2_880,
      audioInjectedWakeGaps: 2,
      audioRecoveredWakeGaps: 2,
      audioTrackFailures: 0,
      normalAudioAgeSampleCount: 300,
      normalAudioAgeP95Us: 23_000,
      normalAudioAgeP99Us: 33_000,
    },
  ])

  assert.deepEqual(selected.map((record) => [
    record.hostEpoch,
    record.evidenceSequence,
  ]), [[1, 2], [2, 1]])
  assert.equal(
    buildDistributionMetrics([], selected)
      .localPlayoutScheduledAgeSampleCount,
    500,
  )
  assert.deepEqual(buildRemoteAudioPlayoutMetrics(selected), {
    protocolVersion: 1,
    trackId: 'contention-audio',
    ingressFrames: 50,
    rendererFillCallbacks: 40,
    renderedSamples: 9_600,
    injectedWakeGaps: 4,
    recoveredWakeGaps: 4,
    trackFailures: 0,
    linkedRoomEpochs: 0,
  })
})

test('probe summaries retain versioned track-to-renderer audio evidence', () => {
  assert.deepEqual(buildRemoteAudioPlayoutMetrics([
    {
      protocolVersion: 1,
      audioTrackId: 'contention-audio',
      audioIngressFrames: 12,
      audioRendererFillCallbacks: 8,
      audioRenderedTrackFrames: 960,
      audioInjectedWakeGaps: 2,
      audioRecoveredWakeGaps: 2,
      audioTrackFailures: 0,
    },
    {
      protocolVersion: 1,
      audioTrackId: 'contention-audio',
      audioIngressFrames: 18,
      audioRendererFillCallbacks: 10,
      audioRenderedTrackFrames: 1_440,
      audioInjectedWakeGaps: 2,
      audioRecoveredWakeGaps: 2,
      audioTrackFailures: 0,
    },
  ]), {
    protocolVersion: 1,
    trackId: 'contention-audio',
    ingressFrames: 30,
    rendererFillCallbacks: 18,
    renderedSamples: 4_800,
    injectedWakeGaps: 4,
    recoveredWakeGaps: 4,
    trackFailures: 0,
    linkedRoomEpochs: 0,
  })

  assert.equal(buildRemoteAudioPlayoutMetrics([{
    protocolVersion: 2,
    audioTrackId: 'contention-audio',
  }]).trackId, '')
})

test('remote audio proof requires a subscribed LiveKit publication per epoch', () => {
  assert.equal(buildRemoteAudioPlayoutMetrics([{
    protocolVersion: 1,
    audioTrackId: 'contention-audio',
    publisherIdentity: 'publisher-1',
    viewerIdentity: 'viewer-1',
    publicationSid: 'TR_audio',
    remoteTrackSid: 'TR_audio',
  }]).linkedRoomEpochs, 1)
  assert.equal(buildRemoteAudioPlayoutMetrics([{
    protocolVersion: 1,
    audioTrackId: 'contention-audio',
  }]).linkedRoomEpochs, 0)
})

test('runner derives frame and audio p95/p99 from bounded native samples', () => {
  const metrics = buildDistributionMetrics(
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    [
      {
        normalAudioAgeSampleCount: 100,
        normalAudioAgeP95Us: 21_000,
        normalAudioAgeP99Us: 31_000,
      },
      {
        normalAudioAgeSampleCount: 100,
        normalAudioAgeP95Us: 24_000,
        normalAudioAgeP99Us: 36_000,
      },
    ],
  )

  assert.deepEqual(metrics, {
    normalVideoFrameAgeP95Ms: 90,
    normalVideoFrameAgeP99Ms: 90,
    localPlayoutScheduledAgeSampleCount: 200,
    localPlayoutScheduledAgeP95Ms: 24,
    localPlayoutScheduledAgeP99Ms: 36,
  })
})

test('runner rejects audio percentiles without a native sample count', () => {
  const metrics = buildDistributionMetrics([10], [{
    normalAudioAgeP95Us: 20_000,
    normalAudioAgeP99Us: 30_000,
  }])

  assert.equal(Number.isNaN(metrics.localPlayoutScheduledAgeP95Ms), true)
  assert.equal(Number.isNaN(metrics.localPlayoutScheduledAgeP99Ms), true)
})

test('native stderr policy admits only bounded reset and callback-hold warnings', () => {
  const healthyContext = {
    linkedVideoPresented: true,
    freshFramesAfterRecovery: 1,
    liveKitCallbackHoldHits: 1,
    videoStreamGenerationsByEpoch: new Map([[2, 2]]),
    linkedVideoPresentationEpochs: new Set([2]),
  }
  assert.deepEqual(classifyNativeProbeStderr([
    {
      hostEpoch: 2,
      line: '[h264 @ 00000001] Frame num change from 1 to 0',
    },
    {
      hostEpoch: 2,
      line: 'native video stream queue overflow; stream_instance=11 dropped 1 queued frames',
    },
  ], healthyContext), [])
  assert.equal(classifyNativeProbeStderr([
    {
      hostEpoch: 1,
      line: '[h264 @ 00000001] Frame num change from 1 to 0',
    },
  ], healthyContext).length, 1)

  const lateJoinBurst = [
    '[h264 @ 00000001] corrupted macroblock 25 53 (total_coeff=-1)',
    '[h264 @ 00000001] error while decoding MB 25 53',
    '[h264 @ 00000001] Broken frame packetizing',
    '[h264 @ 00000001] PPS changed between slices',
    '[h264 @ 00000001] no frame!',
  ].map((line) => ({ hostEpoch: 2, line, beforeFirstPresentation: true }))
  assert.deepEqual(
    classifyNativeProbeStderr(lateJoinBurst, healthyContext),
    lateJoinBurst,
  )
  assert.equal(classifyNativeProbeStderr([
    ...lateJoinBurst,
    ...lateJoinBurst,
  ], healthyContext).length, 10)
  assert.equal(classifyNativeProbeStderr(lateJoinBurst.map((record, index) => ({
    ...record,
    beforeFirstPresentation: index === 4 ? false : true,
  })), healthyContext).length, 5)
  assert.deepEqual(classifyNativeProbeStderr([
    { hostEpoch: 2, line: 'native video stream queue overflow; stream_instance=11 dropped 1 queued frames' },
    { hostEpoch: 2, line: 'native video stream queue overflow; stream_instance=12 dropped 1 queued frames' },
  ], healthyContext), [])
  assert.equal(classifyNativeProbeStderr([
    { hostEpoch: 2, line: 'native video stream queue overflow; stream_instance=11 dropped 1 queued frames' },
    { hostEpoch: 2, line: 'native video stream queue overflow; stream_instance=12 dropped 1 queued frames' },
  ], {
    ...healthyContext,
    videoStreamGenerationsByEpoch: new Map([[2, 1]]),
  }).length, 2)
  assert.equal(classifyNativeProbeStderr([
    { hostEpoch: 2, line: 'native video stream queue overflow; stream_instance=11 dropped 100 queued frames' },
  ], healthyContext).length, 1)
  assert.equal(classifyNativeProbeStderr([
    { hostEpoch: 2, line: 'native video stream queue overflow; stream_instance=11 dropped 1 queued frames' },
    { hostEpoch: 2, line: 'native video stream queue overflow; stream_instance=11 dropped 1 queued frames' },
  ], healthyContext).length, 2)
  assert.equal(classifyNativeProbeStderr([
    { hostEpoch: 2, line: '[h264 @ 00000001] PPS changed between slices' },
  ], healthyContext).length, 1)
  assert.equal(classifyNativeProbeStderr([
    { hostEpoch: 2, line: '[livekit] [warning] SDK was not shut down before process exit.' },
  ], healthyContext).length, 1)
})

test('contention page produces real visible DWM updates for screen capture', () => {
  const html = decodeURIComponent(contentionPageDataUrl().split(',')[1])
  assert.match(html, /requestAnimationFrame/)
  assert.match(html, /canvas/i)
})

test('contention window motion produces deterministic DWM updates', () => {
  const positions = []
  let tick
  const timer = startContentionWindowMotion(
    {
      setBounds: (bounds) => positions.push(bounds),
      setPosition: (x, y) => positions.push({ x, y }),
    },
    { x: 100, y: 200, width: 1920, height: 1080 },
    (callback, delayMs) => {
      tick = callback
      return delayMs
    },
  )

  assert.equal(timer, 16)
  tick()
  tick()
  assert.deepEqual(positions.slice(-2), [
    { x: 134, y: 232 },
    { x: 132, y: 232 },
  ])
})

test('held renderer fence retains the texture without blocking later frames', () => {
  let scheduled
  let released = 0
  releaseAfterRendererFence(
    { release: () => { released += 1 } },
    5_200,
    (callback, delayMs) => { scheduled = { callback, delayMs } },
  )

  assert.equal(released, 0)
  assert.equal(scheduled.delayMs, 5_200)
  scheduled.callback()
  assert.equal(released, 1)
})

test('production profile enforces a real ten-minute observation window', () => {
  assert.throws(
    () => resolveContentionProfile('production', { durationMs: 599_999 }),
    /at least 600000 ms/,
  )
  assert.equal(resolveContentionProfile('production').durationMs, 600_000)
  assert.equal(
    resolveContentionProfile('production').screenBackendChurnIntervalMs,
    240_000,
  )
  assert.equal(resolveContentionProfile('production').probeRestartMinDelayMs, 2_000)
  assert.equal(resolveContentionProfile('production').probeRestartDelayCapMs, null)
  assert.equal(resolveContentionProfile('ci').probeRestartDelayCapMs, 100)
  assert.equal(
    contentionProbeRestartDelayMs(250, resolveContentionProfile('ci')),
    100,
  )
  assert.equal(
    contentionProbeRestartDelayMs(250, resolveContentionProfile('production')),
    2_000,
  )
  assert.equal(
    contentionProbeRestartDelayMs(5_000, resolveContentionProfile('production')),
    5_000,
  )
  assert.equal(resolveContentionProfile('production').measurementWarmupMs, 10_000)
  assert.equal(resolveContentionProfile('production').linkedVideoReadyMs, 45_000)
  assert.equal(
    linkedVideoReadyDeadlineMs(resolveContentionProfile('ci')),
    7_000,
  )
  assert.equal(
    linkedVideoReadyDeadlineMs(resolveContentionProfile('production')),
    45_000,
  )
  const production = resolveContentionProfile('production')
  const [gpuFault] = production.faultSchedule.gpuCompletionDelay
  assert.equal(gpuFault.trigger, 'after-first-held-renderer-frame')
  assert.equal(gpuFault.durationMs, 550)
  assert.equal(
    production.audioRecoveryTrigger,
    'after-renderer-reopen-before-voice-timeout',
  )
  assert.equal(production.faultSchedule.audioSchedulingGap.length, 4)
  assert.ok(production.faultSchedule.audioSchedulingGap.every(
    (fault) => Number.isSafeInteger(fault.afterArmMs),
  ))
  assert.ok(resolveContentionProfile('ci').durationMs < 60_000)
})

test('healthy deterministic contention evidence passes every required boundary', () => {
  const result = evaluateContentionRun(healthyEvidence())

  assert.equal(result.status, 'pass')
  assert.deepEqual(result.blockers, [])
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.faultHits, {
    gpuCompletionDelay: 1,
    electronFenceDelay: 1,
    liveKitCallbackHold: 1,
    audioSchedulingGap: 4,
  })
})

test('production contention evidence is tied to a clean media source commit', () => {
  const missingCommit = healthyEvidence()
  delete missingCommit.environment.source.commitSha
  assert.match(
    evaluateContentionRun(missingCommit).failures.join('\n'),
    /source commit SHA/i,
  )

  const dirtyProduction = healthyEvidence()
  dirtyProduction.profile = resolveContentionProfile('production')
  dirtyProduction.environment.source.relevantWorkingTreeDirty = true
  assert.match(
    evaluateContentionRun(dirtyProduction).failures.join('\n'),
    /dirty media tree/i,
  )
})

test('contention evidence requires one linked capture-to-viewer frame identity', () => {
  const evidence = healthyEvidence()
  delete evidence.metrics.linkedVideoPipeline

  const missing = evaluateContentionRun(evidence)

  assert.equal(missing.status, 'failed')
  assert.match(missing.failures.join('\n'), /linked video pipeline/i)

  evidence.metrics.linkedVideoPipeline = {
    captureFrameId: 'screen:1:frame:42',
    encodedFrameId: 'screen:1:frame:42',
    publicationFrameId: 'screen:1:frame:42',
    remoteFrameId: 'screen:1:frame:43',
    electronFrameId: 'screen:1:frame:42',
    nativeCaptureTimestampUs: 1_150_003,
    remoteCaptureTimestampUs: 1_150_003,
  }

  const mismatched = evaluateContentionRun(evidence)

  assert.equal(mismatched.status, 'failed')
  assert.match(mismatched.failures.join('\n'), /linked video pipeline identity/i)

  const detached = healthyEvidence()
  delete detached.metrics.linkedVideoPipeline.publicationSid
  const detachedResult = evaluateContentionRun(detached)
  assert.equal(detachedResult.status, 'failed')
  assert.match(detachedResult.failures.join('\n'), /LiveKit room participants/i)
})

test('contention evidence requires tracked audio to reach renderer fills and recover wake gaps', () => {
  const evidence = healthyEvidence()
  delete evidence.metrics.remoteAudioPlayout

  const missing = evaluateContentionRun(evidence)

  assert.equal(missing.status, 'failed')
  assert.match(missing.failures.join('\n'), /remote audio playout/i)

  evidence.metrics.remoteAudioPlayout = {
    protocolVersion: 1,
    trackId: 'contention-audio',
    ingressFrames: 600,
    rendererFillCallbacks: 120,
    renderedSamples: 57_600,
    injectedWakeGaps: 4,
    recoveredWakeGaps: 3,
    trackFailures: 0,
    linkedRoomEpochs: 1,
  }

  const incomplete = evaluateContentionRun(evidence)

  assert.equal(incomplete.status, 'failed')
  assert.match(incomplete.failures.join('\n'), /renderer wake-gap recovery/i)
})

test('environment blockers stay distinct from assertion failures', () => {
  const evidence = healthyEvidence()
  evidence.environment.capabilities.hardwareH264 = {
    available: false,
    reason: 'no hardware Media Foundation encoder',
  }

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'blocked')
  assert.deepEqual(result.failures, [])
  assert.match(result.blockers[0], /hardwareH264/)
})

test('audio policy matrix hook is explicit and missing evidence blocks the run', () => {
  assert.equal(
    parseRunnerOptions([
      '--profile',
      'ci',
      '--audio-policy-result',
      'audio-policy.json',
    ]).audioPolicyResult,
    'audio-policy.json',
  )
  const evidence = healthyEvidence()
  delete evidence.audioPolicyMatrix

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'blocked')
  assert.match(result.blockers.join('\n'), /audio policy matrix/i)
})

test('contention runner accepts only named priority policies', () => {
  assert.equal(parseRunnerOptions(['--profile', 'ci']).priorityPolicy, 'normal')
  assert.equal(
    parseRunnerOptions(['--priority-policy', 'capture']).priorityPolicy,
    'capture',
  )
  assert.throws(
    () => parseRunnerOptions(['--priority-policy', 'made-up']),
    /unknown media priority policy/i,
  )
  assert.deepEqual(mediaPriorityPolicyEnvironment('normal'), {
    SYRNIKE_MEDIA_PRIORITY_POLICY: 'normal',
  })
})

test('audio policy matrix validates category, ducking, restart, and Bluetooth outcomes', () => {
  const evidence = healthyEvidence()
  evidence.audioPolicyMatrix.scenarios[0].microphoneCaptureCategory =
    'communications'
  evidence.audioPolicyMatrix.runtimeRestart.policiesReapplied = false
  delete evidence.audioPolicyMatrix.bluetooth

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /non-communications/i)
  assert.match(result.failures.join('\n'), /runtime restart/i)
  assert.match(result.failures.join('\n'), /Bluetooth.*explicit/i)
})

test('absent Bluetooth endpoint pair is the only typed selection blocker', () => {
  const evidence = healthyEvidence()
  evidence.audioPolicyMatrix.bluetooth = {
    available: false,
    status: 'blocked',
    reasonCode: 'bluetooth_endpoint_pair_absent',
    reason: 'no active Bluetooth render and capture endpoint pair is installed',
  }

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'blocked')
  assert.deepEqual(result.blockerDetails, [{
    code: 'bluetooth_endpoint_pair_absent',
    message: result.blockers[0],
  }])
})

test('production audio policy matrix proves reference-app and system volume stability', () => {
  const evidence = healthyEvidence()
  evidence.profile = resolveContentionProfile('production')
  evidence.metrics.elapsedMs = evidence.profile.durationMs
  evidence.metrics.localPlayoutScheduledAgeSampleCount = 30_000
  evidence.metrics.screenBackendChurnCount = 4
  evidence.audioPolicyMatrix.scenarios[3].referenceSessionVolumeAfter = 0.25

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /reference-app session volume/i)
})

test('screen cadence and backend churn evidence are mandatory', () => {
  const evidence = healthyEvidence()
  delete evidence.metrics.screenCadenceFps
  delete evidence.metrics.screenOrdinaryCadenceFps
  delete evidence.metrics.screenBackendChurnRecoveryMaxMs
  delete evidence.metrics.screenBackendChurnCount
  delete evidence.metrics.screenResourceBaselineCaptured

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /screen capture cadence/)
  assert.match(result.failures.join('\n'), /screen backend churn/)
  assert.match(result.failures.join('\n'), /screen capture resource baseline/)
})

test('screen cadence excludes only the exact bounded backend churn interval', () => {
  const evidence = healthyEvidence()
  evidence.metrics.screenCadenceFps = 9.5
  evidence.metrics.screenOrdinaryCadenceFps = 10.5
  evidence.metrics.screenBackendChurnRecoveryMaxMs = 500

  let result = evaluateContentionRun(evidence)
  assert.equal(
    result.failures.some((failure) => /ordinary screen capture cadence/i.test(failure)),
    false,
  )

  evidence.metrics.screenOrdinaryCadenceFps = 9.5
  result = evaluateContentionRun(evidence)
  assert.match(result.failures.join('\n'), /ordinary screen capture cadence/i)

  evidence.metrics.screenOrdinaryCadenceFps = 10.5
  evidence.metrics.screenBackendChurnRecoveryMaxMs = 2_001
  result = evaluateContentionRun(evidence)
  assert.match(result.failures.join('\n'), /screen backend churn recovery/i)
})

test('audio recovery must settle through a real fill inside the ordinary limit', () => {
  const evidence = healthyEvidence()
  evidence.metrics.audioRecoverySettled = 0

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /audio recovery settled.*80 ms/i)
})

test('remote renderer-fence recovery evidence is mandatory and production-shaped', () => {
  const evidence = healthyEvidence()
  delete evidence.metrics.rendererFenceBlockedTransitions
  delete evidence.metrics.gpuFaultArmedAfterHeld
  delete evidence.metrics.rolloverWhileHeldProofs
  delete evidence.metrics.gpuFaultForcedTimeouts
  delete evidence.metrics.remoteVideoPoolRollovers
  delete evidence.metrics.configuredRemoteGpuBytesMax
  delete evidence.metrics.freshFramesAfterRecovery
  delete evidence.metrics.rendererReloadCount
  delete evidence.metrics.rendererFenceHostRecycles
  delete evidence.metrics.voiceControlTimeoutRecycles
  delete evidence.metrics.finalRemoteRendererLeases
  delete evidence.metrics.finalRemoteUsageBytes
  delete evidence.metrics.finalRemoteUsageGenerations
  delete evidence.metrics.audioRecoverySamples
  delete evidence.metrics.audioRecoveryArmed

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /renderer fence blocked/i)
  assert.match(result.failures.join('\n'), /GPU fault armed after held frame/i)
  assert.match(result.failures.join('\n'), /rollover while renderer fence held/i)
  assert.match(result.failures.join('\n'), /forced GPU completion timeouts/i)
  assert.match(result.failures.join('\n'), /remote video pool rollovers/i)
  assert.match(result.failures.join('\n'), /configured remote GPU backing/i)
  assert.match(result.failures.join('\n'), /fresh frame after recovery/i)
  assert.match(result.failures.join('\n'), /renderer reload/i)
  assert.match(result.failures.join('\n'), /renderer-fence host recycle/i)
  assert.match(result.failures.join('\n'), /voice-control timeout recycle/i)
  assert.match(result.failures.join('\n'), /final remote renderer leases/i)
  assert.match(result.failures.join('\n'), /final remote usage/i)
  assert.match(result.failures.join('\n'), /audio recovery samples/i)
})

test('camera preview requires a real delayed fence and renderer-loss recovery', () => {
  const evidence = healthyEvidence()
  delete evidence.environment.capabilities.cameraPreview
  delete evidence.metrics.cameraPreviewHandleImports
  delete evidence.metrics.cameraPreviewDelayedFenceHits
  delete evidence.metrics.cameraPreviewRendererLosses
  delete evidence.metrics.cameraPreviewFreshFramesAfterLoss
  delete evidence.metrics.cameraPreviewFenceAcks
  delete evidence.metrics.cameraPreviewReleaseFailures
  delete evidence.metrics.finalCameraPreviewFrames
  delete evidence.metrics.finalCameraPreviewUsageBytes
  delete evidence.metrics.finalCameraPreviewUsageGenerations

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'blocked')
  assert.match(result.blockers.join('\n'), /cameraPreview/i)
  assert.match(result.failures.join('\n'), /camera preview shared-handle imports/i)
  assert.match(result.failures.join('\n'), /camera preview delayed fence/i)
  assert.match(result.failures.join('\n'), /camera preview renderer loss/i)
  assert.match(result.failures.join('\n'), /fresh camera preview frame after renderer loss/i)
  assert.match(result.failures.join('\n'), /camera preview fence acknowledgements/i)
  assert.match(result.failures.join('\n'), /camera preview release failures/i)
  assert.match(result.failures.join('\n'), /final camera preview frames/i)
  assert.match(result.failures.join('\n'), /final camera preview usage bytes/i)
  assert.match(result.failures.join('\n'), /final camera preview usage generations/i)
})

test('remote GPU backing follows the linked publication instead of the 4K control', () => {
  const evidence = healthyEvidence()
  evidence.metrics.linkedVideoPipeline.publicationWidth = 1_920
  evidence.metrics.linkedVideoPipeline.publicationHeight = 1_080
  evidence.metrics.configuredRemoteGpuBytesMax =
    1_920 * 1_080 * 4 * 5 * evidence.metrics.maximumRemoteGpuGenerations

  const result = evaluateContentionRun(evidence)

  assert.equal(
    result.failures.some((failure) =>
      /configured remote GPU backing/i.test(failure)),
    false,
  )
})

test('resource churn cannot use the process-start fallback baseline', () => {
  const evidence = healthyEvidence()
  evidence.metrics.resourceBaselineCaptured = 0

  const result = evaluateContentionRun(evidence)

  assert.match(result.failures.join('\n'), /resource baseline captured/i)
})

test('resource churn excludes a final probe stopped before its stable baseline', () => {
  const measured = selectResourceBaselineSummaries([
    { hostEpoch: 1, republishCount: 1, resourceBaselineCaptured: 1, threadDeltaMax: 4 },
    { hostEpoch: 2, republishCount: 1, resourceBaselineCaptured: 1, threadDeltaMax: 6 },
    { hostEpoch: 3, republishCount: 0, resourceBaselineCaptured: 0, threadDeltaMax: 92 },
  ])

  assert.deepEqual(measured.map((summary) => summary.hostEpoch), [1, 2])
  assert.equal(resourceBaselinesComplete([
    { republishCount: 1, resourceBaselineCaptured: 1 },
    { republishCount: 0, resourceBaselineCaptured: 0 },
  ]), true)
  assert.equal(resourceBaselinesComplete([
    { republishCount: 1, resourceBaselineCaptured: 0 },
  ]), false)
})

test('a linked current probe cannot finish before its stable resource baseline', () => {
  assert.equal(shouldAwaitResourceBaseline(3, new Set([3]), new Set()), true)
  assert.equal(
    shouldAwaitResourceBaseline(3, new Set([3]), new Set([3])),
    false,
  )
  assert.equal(shouldAwaitResourceBaseline(3, new Set([1]), new Set()), false)
})

test('completion phase waits for serialized recycles and fully drained media ownership', () => {
  const ready = {
    voiceTimeoutRecycleCompleted: true,
    demandRemovalCompleted: true,
    pendingStartup: 0,
    pendingMainOperations: 0,
    remoteRendererLeases: 0,
    remoteGpuGenerations: 0,
    resourceBaselineCaptured: true,
  }
  assert.deepEqual(contentionCompletionBlockers(ready), [])

  for (const [field, value] of [
    ['voiceTimeoutRecycleCompleted', false],
    ['demandRemovalCompleted', false],
    ['pendingStartup', 1],
    ['pendingMainOperations', 1],
    ['remoteRendererLeases', 1],
    ['remoteGpuGenerations', 1],
    ['resourceBaselineCaptured', false],
  ]) {
    assert.ok(
      contentionCompletionBlockers({ ...ready, [field]: value }).length > 0,
      `${field} did not block finalization`,
    )
  }
})

test('completion deadline covers each named serialized recovery contract', () => {
  const contracts = {
    voiceReleaseRecoveryMs: 6_500,
    gracefulRetirementMs: 8_000,
    replacementPreflightMs: 5_000,
    schedulerMs: 100,
  }
  const required = contentionCompletionDeadlineMs(contracts)
  assert.equal(required, 19_600)
  assert.equal(required - 1 >= contentionCompletionDeadlineMs(contracts), false)
  assert.equal(required >= contentionCompletionDeadlineMs(contracts), true)
})

test('a replacement probe stays alive through the explicit completion contract', () => {
  assert.equal(contentionObservationElapsedMs(null, 4_000), 0)
  assert.equal(contentionObservationElapsedMs(4_000, 16_000), 12_000)
  assert.equal(contentionProbeDurationMs({
    elapsedMs: 16_000,
    observationMs: 12_000,
    completionMs: 19_600,
    safetyMarginMs: 5_000,
  }), 20_600)
  assert.equal(contentionProbeDurationMs({
    elapsedMs: 40_000,
    observationMs: 12_000,
    completionMs: 19_600,
    safetyMarginMs: 5_000,
  }), 5_000)
})

test('an unresolved remote delivery remains a completion blocker after frame maps drain', async () => {
  const pendingDeliveries = new Set()
  let resolveDelivery
  const delivery = new Promise((resolve) => { resolveDelivery = resolve })

  const ownedDelivery = trackPendingOperation(pendingDeliveries, delivery)
  assert.equal(pendingDeliveries.size, 1)
  assert.deepEqual(
    contentionCompletionBlockers({
      voiceTimeoutRecycleCompleted: true,
      demandRemovalCompleted: true,
      pendingStartup: 0,
      pendingMainOperations: pendingDeliveries.size,
      remoteRendererLeases: 0,
      remoteGpuGenerations: 0,
      resourceBaselineCaptured: true,
    }),
    ['pending-main-operations'],
  )

  resolveDelivery()
  await ownedDelivery
  assert.equal(pendingDeliveries.size, 0)
})

test('release latency separates owner retirement from an ordinary ready-host ACK', () => {
  assert.equal(isRetiredRendererRelease(2, {
    status: 'recovering',
    hostEpoch: 2,
  }), true)
  assert.equal(isRetiredRendererRelease(2, {
    status: 'ready',
    hostEpoch: 3,
  }), true)
  assert.equal(isRetiredRendererRelease(2, {
    status: 'ready',
    hostEpoch: 2,
  }), false)
})

test('skipped native RELEASE after probe recycle still counts injected recovery', () => {
  assert.equal(isBridgeSkippedRetiredRelease(1, 2), true)
  assert.equal(isBridgeSkippedRetiredRelease(2, 2), false)
  assert.equal(isCorrelatedInjectedRetirement(1, {
    fenceOwnerEpoch: 1,
    rendererFenceRecycleCompleted: true,
    voiceTimeoutEpoch: 2,
    voiceTimeoutArmed: false,
  }), true)
  assert.equal(isCorrelatedInjectedRetirement(2, {
    fenceOwnerEpoch: 1,
    rendererFenceRecycleCompleted: true,
    voiceTimeoutEpoch: 2,
    voiceTimeoutArmed: false,
  }), false)
})

test('probe churn of the fence-owner epoch counts as renderer-fence recycle', () => {
  const empty = {
    fenceOwnerEpoch: null,
    voiceTimeoutEpoch: null,
    voiceTimeoutArmed: false,
    rendererFenceRecycleCompleted: false,
    rendererFenceHostRecycles: 0,
    voiceTimeoutRecycleCompleted: false,
    voiceControlTimeoutRecycles: 0,
  }
  const epochOne = assignContentionRecoveryEpochs(empty, 0, 1)
  assert.equal(epochOne.fenceOwnerEpoch, 1)
  const churned = assignContentionRecoveryEpochs(epochOne, 1, 2)
  assert.equal(churned.rendererFenceRecycleCompleted, true)
  assert.equal(churned.rendererFenceHostRecycles, 1)
  assert.equal(churned.voiceTimeoutEpoch, 2)
  const voiceRecycled = assignContentionRecoveryEpochs({
    ...churned,
    voiceTimeoutArmed: true,
  }, 2, 3)
  assert.equal(voiceRecycled.voiceTimeoutRecycleCompleted, true)
  assert.equal(voiceRecycled.voiceControlTimeoutRecycles, 1)
})

test('unarmed recovery host crash follows to the next epoch', () => {
  const afterFence = assignContentionRecoveryEpochs({
    fenceOwnerEpoch: 1,
    voiceTimeoutEpoch: 2,
    voiceTimeoutArmed: false,
    rendererFenceRecycleCompleted: true,
    rendererFenceHostRecycles: 1,
    voiceTimeoutRecycleCompleted: false,
    voiceControlTimeoutRecycles: 0,
  }, 2, 3)
  assert.equal(afterFence.voiceTimeoutEpoch, 3)
  assert.equal(afterFence.voiceTimeoutRecycleCompleted, false)
  assert.equal(afterFence.voiceControlTimeoutRecycles, 0)
})

test('replaced probe crash remains an operational failure', () => {
  const evidence = healthyEvidence()
  evidence.operationalFailures = [
    'native-probe-epoch-2 exited with 3221226505',
  ]

  const result = evaluateContentionRun(evidence)
  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /native-probe-epoch-2 exited/)
})

test('injected release retirement remains bounded and fault-correlated', () => {
  const evidence = healthyEvidence()
  evidence.metrics.injectedReleaseRecoveryDurationMaxMs = 6_501
  evidence.metrics.uncorrelatedReleaseRetirements = 1

  const result = evaluateContentionRun(evidence)
  assert.match(result.failures.join('\n'), /injected release recovery duration/i)
  assert.match(result.failures.join('\n'), /uncorrelated release retirement/i)
})

test('audio recovery evidence retains four exact post-reopen samples', () => {
  const evidence = healthyEvidence()
  evidence.metrics.audioRecoverySamples = evidence.metrics.audioRecoverySamples
    .slice(0, 3)

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /audio recovery samples/i)
})

test('screen GPU timeout budget accounts for planned backend retirement', () => {
  const evidence = healthyEvidence()
  evidence.profile = resolveContentionProfile('production')
  Object.assign(evidence.metrics, {
    elapsedMs: evidence.profile.durationMs,
    localPlayoutScheduledAgeSampleCount: 30_000,
    screenBackendChurnCount: 4,
    screenGpuSlotTimeouts: 4,
  })

  const bounded = evaluateContentionRun(evidence)
  assert.equal(bounded.status, 'pass')
  assert.doesNotMatch(bounded.failures.join('\n'), /screen GPU slot timeouts/)

  evidence.metrics.screenGpuSlotTimeouts = 7
  const storm = evaluateContentionRun(evidence)
  assert.equal(storm.status, 'failed')
  assert.match(storm.failures.join('\n'), /screen GPU slot timeouts/)
})

test('contention evidence rejects a benchmark that bypasses priority policy', () => {
  const evidence = healthyEvidence()
  delete evidence.priorityOutcome

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /capture priority outcome/i)
})

test('failed MMCSS and D3D priority settings are assertion failures', () => {
  const evidence = healthyEvidence()
  evidence.priorityOutcome.captureMmcss = {
    requested: true,
    registered: false,
    win32Error: 5,
  }
  evidence.priorityOutcome.publicationD3d = {
    requested: 1,
    applied: 0,
    hresult: -2_007_270_522,
  }

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /MMCSS.*5/i)
  assert.match(result.failures.join('\n'), /publication D3D.*-2007270522/i)
})

test('competing workload cadence and p95/p99 are regression boundaries', () => {
  const evidence = healthyEvidence()
  Object.assign(evidence.metrics, {
    competingWorkloadFps: 42,
    competingWorkloadP95Ms: 30,
    competingWorkloadP99Ms: 55,
  })

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /competing workload cadence/i)
  assert.match(result.failures.join('\n'), /competing workload p95/i)
  assert.match(result.failures.join('\n'), /competing workload p99/i)
})

test('frame and audio p95/p99 distributions are mandatory evidence', () => {
  const evidence = healthyEvidence()
  delete evidence.metrics.normalVideoFrameAgeP95Ms
  delete evidence.metrics.localPlayoutScheduledAgeP95Ms
  delete evidence.metrics.localPlayoutScheduledAgeP99Ms

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /video frame age p95/i)
  assert.match(result.failures.join('\n'), /playout scheduled age p95/i)
  assert.match(result.failures.join('\n'), /playout scheduled age p99/i)
})

test('audio latency distribution enforces the profile sample minimum', () => {
  const evidence = healthyEvidence()
  evidence.metrics.localPlayoutScheduledAgeSampleCount = 599

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.match(result.failures.join('\n'), /playout scheduled age samples/i)
})

test('early reuse, leaked ownership, stale media and recovery storms fail together', () => {
  const evidence = healthyEvidence()
  Object.assign(evidence.metrics, {
    uiEventLoopMaxMs: 1_900,
    normalVideoFrameAgeMaxMs: 2_000,
    releaseRequestLatencyMaxMs: 3_000,
    finalPendingOperations: 2,
    maximumQuarantinedGenerations: 3,
    approximateGpuBytesMax: 600 * 1024 * 1024,
    prematureTextureReuse: 1,
    resetCount: 8,
    republishCount: 9,
  })

  const result = evaluateContentionRun(evidence)

  assert.equal(result.status, 'failed')
  assert.equal(result.blockers.length, 0)
  assert.match(result.failures.join('\n'), /event loop/)
  assert.match(result.failures.join('\n'), /premature texture reuse/)
  assert.match(result.failures.join('\n'), /reset storm/)
  assert.match(result.failures.join('\n'), /republish storm/)
})

test('bounded artifact keeps correlated anomalies, drops old samples and redacts secrets', () => {
  const evidence = healthyEvidence()
  evidence.timeline = Array.from({ length: 40 }, (_, index) => ({
    event: 'media_timeline',
    stage: index === 3 ? 'gpu_completion_timeout' : 'renderer_presented',
    sessionId: 'contention-session',
    generation: 7,
    trackId: 'remote-screen',
    frameSequence: index + 1,
    nativeCaptureTimestampUs: 1_000_000 + index * 16_667,
    runtimeEpoch: 2,
    participantIdentity: 'user:secret@example.test',
    accessToken: 'super-secret-token',
    anomaly: index === 3,
  }))

  const artifact = buildContentionArtifact(evidence, {
    maximumBytes: 8_192,
    maximumTimelineRecords: 8,
  })
  const serialized = JSON.stringify(artifact)

  assert.ok(Buffer.byteLength(serialized) <= 8_192)
  assert.ok(artifact.timeline.length <= 8)
  assert.ok(
    artifact.timeline.some((record) => record.stage === 'gpu_completion_timeout'),
  )
  assert.equal(artifact.priorityOutcome.policy, 'capture')
  assert.equal(artifact.priorityOutcome.captureMmcss.registered, true)
  assert.doesNotMatch(serialized, /secret@example|super-secret-token/)
  assert.match(serialized, /peer-1/)
})

test('child teardown has one deadline and reports an unkillable owned child', async () => {
  const cooperative = fakeChild(101, true)
  const stuck = fakeChild(202, false)

  const result = await shutdownChildren([cooperative, stuck], {
    deadlineMs: 20,
    forceAfterMs: 5,
  })

  assert.equal(cooperative.killCalls, 1)
  assert.ok(stuck.killCalls >= 2)
  assert.deepEqual(result.orphanPids, [202])
  assert.ok(result.elapsedMs < 100)
})

test('metric sampling stays bounded without shifting the hot-path array', () => {
  const samples = new BoundedSampleWindow(3)
  for (const value of [1, 2, 3, 4, 5]) samples.add(value)

  assert.equal(samples.size, 3)
  assert.deepEqual([...samples.values()].sort((a, b) => a - b), [3, 4, 5])
})

function healthyEvidence() {
  return {
    profile: resolveContentionProfile('ci'),
    environment: {
      platform: 'win32',
      source: {
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        relevantWorkingTreeDirty: false,
      },
      capabilities: {
        screenCapture: { available: true },
        hardwareH264: { available: true },
        electronSharedTexture: { available: true },
        remoteViewer: { available: true },
        cameraPreview: { available: true },
        audioOutput: { available: true },
      },
    },
    faultHits: {
      gpuCompletionDelay: 1,
      electronFenceDelay: 1,
      liveKitCallbackHold: 1,
      audioSchedulingGap: 4,
    },
    audioPolicyMatrix: healthyAudioPolicyMatrix(),
    priorityOutcome: {
      policy: 'capture',
      captureThread: {
        requested: 0,
        applied: 0,
        succeeded: true,
        win32Error: 0,
      },
      captureMmcss: {
        requested: true,
        registered: true,
        win32Error: 0,
      },
      publicationD3d: {
        requested: 1,
        applied: 1,
        hresult: 0,
      },
      previewD3d: {
        requested: 0,
        applied: 0,
        hresult: 0,
      },
    },
    metrics: {
      elapsedMs: 12_000,
      uiEventLoopP95Ms: 18,
      uiEventLoopP99Ms: 28,
      uiEventLoopMaxMs: 42,
      normalVideoFrameAgeP95Ms: 80,
      normalVideoFrameAgeP99Ms: 120,
      normalVideoFrameAgeMaxMs: 180,
      localPlayoutScheduledAgeP95Ms: 24,
      localPlayoutScheduledAgeP99Ms: 32,
      localPlayoutScheduledAgeSampleCount: 1_000,
      localPlayoutScheduledAgeMaxMs: 38,
      postRecoveryPlayoutAgeMaxMs: 25,
      injectedAudioScheduledAgeMaxMs: 110,
      releaseRequestLatencyMaxMs: 350,
      injectedReleaseRecoveryDurationMaxMs: 4_900,
      injectedReleaseRetirementRecoveries: 2,
      uncorrelatedReleaseRetirements: 0,
      injectedRendererFenceLatencyMaxMs: 5_200,
      screenCaptureFrames: 600,
      screenCadenceFps: 55,
      screenOrdinaryCadenceFps: 55,
      screenCadenceGapMaxMs: 320,
      screenBackendChurnCount: 1,
      screenBackendChurnRecoveryMaxMs: 500,
      screenRecoverableTransitions: 0,
      screenGpuSlotTimeouts: 0,
      screenGpuPoolRollovers: 0,
      screenCaptureResetCount: 0,
      screenResourceBaselineCaptured: 1,
      screenThreadDeltaMax: 4,
      screenHandleDeltaMax: 12,
      competingWorkloadFps: 58,
      competingWorkloadP95Ms: 18,
      competingWorkloadP99Ms: 28,
      threadDeltaMax: 8,
      threadDeltaFinal: 0,
      resourceBaselineCaptured: 1,
      handleDeltaMax: 32,
      pendingOperationsMax: 8,
      finalPendingOperations: 0,
      maximumActiveGenerations: 2,
      maximumQuarantinedGenerations: 1,
      maximumActiveBackends: 2,
      maximumQuarantinedBackends: 1,
      approximateGpuBytesMax: 180 * 1024 * 1024,
      rendererFenceBlockedTransitions: 1,
      gpuFaultArmedAfterHeld: 1,
      rolloverWhileHeldProofs: 1,
      gpuFaultForcedTimeouts: 4,
      rendererBlockedTimedWakeups: 0,
      remoteVideoPoolRollovers: 2,
      configuredRemoteFourKPoolBytes: 166_133_760,
      configuredRemoteGpuBytesMax: 166_133_760,
      maximumRemoteGpuGenerations: 2,
      remoteHandleImports: 6,
      remoteFenceAcks: 3,
      cameraPreviewHandleImports: 3,
      cameraPreviewDelayedFenceHits: 1,
      cameraPreviewRendererLosses: 1,
      cameraPreviewFreshFramesAfterLoss: 1,
      cameraPreviewFenceAcks: 3,
      cameraPreviewReleaseFailures: 0,
      finalCameraPreviewFrames: 0,
      finalCameraPreviewUsageBytes: 0,
      finalCameraPreviewUsageGenerations: 0,
      freshFramesAfterRecovery: 1,
      rendererReloadCount: 1,
      rendererFenceHostRecycles: 1,
      voiceControlTimeoutRecycles: 1,
      demandRemovals: 1,
      finalRemoteRendererLeases: 0,
      finalRemoteUsageBytes: 0,
      finalRemoteUsageGenerations: 0,
      finalElectronInFlightTextures: 0,
      finalElectronRetainedTextureBytes: 0,
      audioRecoverySamples: [
        { index: 0, scheduledPlayoutAgeUs: 110_000 },
        { index: 1, scheduledPlayoutAgeUs: 108_000 },
        { index: 2, scheduledPlayoutAgeUs: 112_000 },
        { index: 3, scheduledPlayoutAgeUs: 109_000 },
      ],
      audioRecoverySettled: 1,
      audioRecoveryArmed: 1,
      linkedVideoPipeline: {
        captureFrameId: 'screen:1:frame:42',
        encodedFrameId: 'screen:1:frame:42',
        publicationFrameId: 'screen:1:frame:42',
        remoteFrameId: 'screen:1:frame:42',
        electronFrameId: 'screen:1:frame:42',
        nativeCaptureTimestampUs: 1_150_003,
        remoteCaptureTimestampUs: 1_150_003,
        roomName: 'issue83-local',
        publisherIdentity: 'contention-publisher-1',
        viewerIdentity: 'contention-viewer-1',
        publicationSid: 'TR_publication',
        remoteTrackSid: 'TR_publication',
        publicationWidth: 1_920,
        publicationHeight: 1_080,
      },
      remoteAudioPlayout: {
        protocolVersion: 1,
        trackId: 'contention-audio',
        ingressFrames: 600,
        rendererFillCallbacks: 120,
        renderedSamples: 57_600,
        injectedWakeGaps: 4,
        recoveredWakeGaps: 4,
        trackFailures: 0,
        linkedRoomEpochs: 1,
      },
      prematureTextureReuse: 0,
      resetCount: 1,
      republishCount: 1,
      finalHeldLeases: 0,
    },
    timeline: [
      {
        event: 'media_timeline',
        stage: 'gpu_completion_timeout',
        sessionId: 'contention-session',
        generation: 7,
        trackId: 'remote-screen',
        frameSequence: 9,
        nativeCaptureTimestampUs: 1_150_003,
        runtimeEpoch: 2,
        anomaly: true,
      },
    ],
  }
}

function healthyAudioPolicyMatrix() {
  const scenarios = []
  for (const endpoint of ['default', 'explicit']) {
    scenarios.push(
      {
        mode: 'warm_microphone',
        endpoint,
        status: 'pass',
        microphoneCaptureCategory: 'other',
      },
      {
        mode: 'remote_render',
        endpoint,
        status: 'pass',
        renderDuckingOptOut: 'applied',
      },
      {
        mode: 'screen_audio',
        endpoint,
        status: 'pass',
        screenCaptureCategory: 'other',
      },
      {
        mode: 'combined',
        endpoint,
        status: 'pass',
        microphoneCaptureCategory: 'other',
        screenCaptureCategory: 'other',
        renderDuckingOptOut: 'applied',
      },
    )
  }
  return {
    schema: 'syrnike.windows-audio-policy-matrix',
    version: 1,
    scenarios: scenarios.map((scenario) => ({
      ...scenario,
      systemVolumeBefore: 0.5,
      systemVolumeAfter: 0.5,
      referenceSessionVolumeBefore: 0.5,
      referenceSessionVolumeAfter: 0.5,
    })),
    bluetooth: { available: true, status: 'pass' },
    runtimeRestart: { status: 'pass', policiesReapplied: true },
  }
}

function fakeChild(pid, exits) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.killCalls = 0
  child.kill = () => {
    child.killCalls += 1
    if (exits && child.exitCode === null) {
      child.exitCode = 0
      queueMicrotask(() => child.emit('exit', 0, null))
    }
    return true
  }
  return child
}
