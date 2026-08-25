const REQUIRED_CAPABILITIES = [
  'screenCapture',
  'hardwareH264',
  'electronSharedTexture',
  'remoteViewer',
  'cameraPreview',
  'audioOutput',
]

const REQUIRED_FAULT_HITS = {
  gpuCompletionDelay: 1,
  electronFenceDelay: 1,
  liveKitCallbackHold: 1,
  audioSchedulingGap: 4,
}

const REMOTE_VIDEO_POOL_SLOTS = 5

const PRIORITY_COMPETING_LIMITS = {
  framesPerSecondMin: 50,
  p95MsMax: 25,
  p99MsMax: 40,
}

const PROFILE_DEFINITIONS = {
  ci: {
    name: 'ci',
    durationMs: 12_000,
    minimumAudioAgeSamples: 600,
    measurementWarmupMs: 2_000,
    linkedVideoReadyMs: 7_000,
    screenBackendChurnIntervalMs: 6_000,
    maximumArtifactBytes: 512 * 1024,
    maximumTimelineRecords: 2_048,
    probeRestartMinDelayMs: 0,
    probeRestartDelayCapMs: 100,
    rendererFenceRecovery: {
      reloadDeadlineMs: 1_000,
      recycleDeadlineMs: 3_000,
      retainedFenceMs: 7_000,
    },
    audioRecoveryTrigger: 'after-renderer-reopen-before-voice-timeout',
    faultSchedule: {
      gpuCompletionDelay: [{
        trigger: 'after-first-held-renderer-frame',
        durationMs: 550,
      }],
      electronFenceDelay: [{ atMs: 2_000, durationMs: 7_000 }],
      liveKitCallbackHold: [{ atMs: 1_500, durationMs: 300 }],
      audioSchedulingGap: [
        { afterArmMs: 50, durationMs: 80 },
        { afterArmMs: 250, durationMs: 80 },
        { afterArmMs: 450, durationMs: 80 },
        { afterArmMs: 650, durationMs: 80 },
      ],
    },
  },
  production: {
    name: 'production',
    durationMs: 600_000,
    minimumAudioAgeSamples: 30_000,
    measurementWarmupMs: 10_000,
    linkedVideoReadyMs: 45_000,
    screenBackendChurnIntervalMs: 240_000,
    probeRestartMinDelayMs: 2_000,
    probeRestartDelayCapMs: null,
    maximumArtifactBytes: 2 * 1024 * 1024,
    maximumTimelineRecords: 8_192,
    rendererFenceRecovery: {
      reloadDeadlineMs: 5_000,
      recycleDeadlineMs: 10_000,
      retainedFenceMs: 20_000,
    },
    audioRecoveryTrigger: 'after-renderer-reopen-before-voice-timeout',
    faultSchedule: {
      gpuCompletionDelay: [{
        trigger: 'after-first-held-renderer-frame',
        durationMs: 550,
      }],
      electronFenceDelay: [{ atMs: 120_000, durationMs: 20_000 }],
      liveKitCallbackHold: [{ atMs: 180_000, durationMs: 500 }],
      audioSchedulingGap: [
        { afterArmMs: 30_000, durationMs: 80 },
        { afterArmMs: 150_000, durationMs: 80 },
        { afterArmMs: 270_000, durationMs: 80 },
        { afterArmMs: 390_000, durationMs: 80 },
      ],
    },
  },
}

const LIMITS = {
  uiEventLoopP95Ms: 50,
  uiEventLoopP99Ms: 100,
  uiEventLoopMaxMs: 1_500,
  normalVideoFrameAgeP95Ms: 250,
  normalVideoFrameAgeP99Ms: 500,
  normalVideoFrameAgeMaxMs: 1_500,
  localPlayoutScheduledAgeP95Ms: 80,
  localPlayoutScheduledAgeP99Ms: 80,
  localPlayoutScheduledAgeMaxMs: 80,
  postRecoveryPlayoutAgeMaxMs: 160,
  injectedAudioScheduledAgeMinMs: 80,
  releaseRequestLatencyMaxMs: 1_000,
  injectedReleaseRecoveryDurationMaxMs: 6_500,
  injectedRendererFenceLatencyMinMs: 5_000,
  screenCaptureFramesMin: 1,
  screenCadenceFpsMin: 10,
  screenCadenceGapMaxMs: 2_500,
  screenBackendChurnRecoveryMaxMs: 2_000,
  screenRecoverableTransitions: 10,
  screenGpuSlotTimeouts: 2,
  screenGpuPoolRollovers: 3,
  screenCaptureResetCount: 3,
  screenThreadDeltaMax: 32,
  screenHandleDeltaMax: 128,
  threadDeltaMax: 16,
  handleDeltaMax: 64,
  pendingOperationsMax: 16,
  maximumActiveGenerations: 2,
  maximumQuarantinedGenerations: 1,
  maximumActiveBackends: 2,
  maximumQuarantinedBackends: 1,
  approximateGpuBytesMax: 384 * 1024 * 1024,
  maximumRemoteGpuGenerations: 2,
  resetCount: 3,
  republishCount: 3,
}

function contentionProbeRestartDelayMs(delayMs, profile) {
  const requested = Number(delayMs)
  if (!Number.isFinite(requested) || requested < 0) {
    throw new Error('probe restart delay must be a non-negative number')
  }
  const minMs = Number(profile?.probeRestartMinDelayMs)
  const floor = Number.isFinite(minMs) && minMs > 0 ? minMs : 0
  const raised = Math.max(requested, floor)
  const capMs = profile?.probeRestartDelayCapMs
  if (capMs == null) return raised
  const parsedCap = Number(capMs)
  if (Number.isFinite(parsedCap) && parsedCap >= 0) {
    return Math.min(raised, parsedCap)
  }
  return raised
}

function linkedVideoReadyDeadlineMs(profile) {
  const warmupMs = Number(profile?.measurementWarmupMs)
  const configured = Number(profile?.linkedVideoReadyMs)
  const fromWarmup = Number.isFinite(warmupMs)
    ? Math.max(5_000, warmupMs + 5_000)
    : 5_000
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(fromWarmup, configured)
  }
  return fromWarmup
}

function resolveContentionProfile(name, overrides = {}) {
  const definition = PROFILE_DEFINITIONS[name]
  if (!definition) {
    throw new Error(`unknown media contention profile: ${name}`)
  }
  const profile = deepClone({ ...definition, ...overrides, name })
  if (!Number.isSafeInteger(profile.durationMs) || profile.durationMs <= 0) {
    throw new Error('contention duration must be a positive integer')
  }
  if (name === 'production' && profile.durationMs < 600_000) {
    throw new Error('production contention duration must be at least 600000 ms')
  }
  if (name === 'ci' && profile.durationMs >= 60_000) {
    throw new Error('CI contention duration must remain below 60000 ms')
  }
  const [gpuFault] = profile.faultSchedule.gpuCompletionDelay
  if (gpuFault?.trigger !== 'after-first-held-renderer-frame') {
    throw new Error('GPU completion fault must be armed after the first held frame')
  }
  if (profile.audioRecoveryTrigger !==
    'after-renderer-reopen-before-voice-timeout') {
    throw new Error('audio recovery must start after renderer reopen')
  }
  const audioFaults = profile.faultSchedule.audioSchedulingGap
  if (audioFaults.length !== REQUIRED_FAULT_HITS.audioSchedulingGap ||
    audioFaults.some((fault, index) =>
      !Number.isSafeInteger(fault.afterArmMs) || fault.afterArmMs < 0 ||
      (index > 0 && fault.afterArmMs <= audioFaults[index - 1].afterArmMs))) {
    throw new Error('audio recovery requires four ordered post-arm samples')
  }
  return profile
}

function evaluateContentionRun(evidence) {
  const profile = evidence.profile
  if (!profile || !PROFILE_DEFINITIONS[profile.name]) {
    throw new Error('contention evidence has no resolved profile')
  }
  const blockers = []
  const blockerDetails = []
  const addBlocker = (code, message) => {
    blockers.push(message)
    blockerDetails.push({ code, message })
  }
  for (const capability of REQUIRED_CAPABILITIES) {
    const state = evidence.environment?.capabilities?.[capability]
    if (state?.available === true) continue
    addBlocker(
      'required_capability_unavailable',
      `${capability}: ${state?.reason || 'capability probe did not pass'}`,
    )
  }

  const failures = []
  const source = evidence.environment?.source
  if (!/^[0-9a-f]{40}$/i.test(source?.commitSha ?? '')) {
    failures.push('source commit SHA is missing from contention evidence')
  }
  if (profile.name === 'production' && source?.relevantWorkingTreeDirty !== false) {
    failures.push('production contention evidence was captured from a dirty media tree')
  }
  for (const failure of evidence.operationalFailures ?? []) {
    failures.push(`runner operation failed: ${String(failure)}`)
  }
  evaluateAudioPolicyMatrix(evidence, addBlocker, failures)
  if (!evidence.priorityOutcome) {
    failures.push('capture priority outcome was not reported by the benchmark')
  } else {
    evaluatePriorityOutcome(evidence.priorityOutcome, failures)
  }
  const metrics = evidence.metrics ?? {}
  requireMinimum(
    failures,
    'elapsed observation',
    metrics.elapsedMs,
    profile.durationMs,
  )
  requireMaximum(
    failures,
    'UI event loop p95',
    metrics.uiEventLoopP95Ms,
    LIMITS.uiEventLoopP95Ms,
  )
  requireMaximum(
    failures,
    'UI event loop p99',
    metrics.uiEventLoopP99Ms,
    LIMITS.uiEventLoopP99Ms,
  )
  requireMaximum(
    failures,
    'UI event loop max',
    metrics.uiEventLoopMaxMs,
    LIMITS.uiEventLoopMaxMs,
  )
  requireMaximum(
    failures,
    'normal video frame age p95',
    metrics.normalVideoFrameAgeP95Ms,
    LIMITS.normalVideoFrameAgeP95Ms,
  )
  requireMaximum(
    failures,
    'normal video frame age p99',
    metrics.normalVideoFrameAgeP99Ms,
    LIMITS.normalVideoFrameAgeP99Ms,
  )
  requireMaximum(
    failures,
    'normal video frame age',
    metrics.normalVideoFrameAgeMaxMs,
    LIMITS.normalVideoFrameAgeMaxMs,
  )
  requireMaximum(
    failures,
    'local playout scheduled age p95',
    metrics.localPlayoutScheduledAgeP95Ms,
    LIMITS.localPlayoutScheduledAgeP95Ms,
  )
  requireMaximum(
    failures,
    'local playout scheduled age p99',
    metrics.localPlayoutScheduledAgeP99Ms,
    LIMITS.localPlayoutScheduledAgeP99Ms,
  )
  requireMinimum(
    failures,
    'local playout scheduled age samples',
    metrics.localPlayoutScheduledAgeSampleCount,
    profile.minimumAudioAgeSamples,
  )
  requireMaximum(
    failures,
    'local playout scheduled age',
    metrics.localPlayoutScheduledAgeMaxMs,
    LIMITS.localPlayoutScheduledAgeMaxMs,
  )
  requireMaximum(
    failures,
    'post-recovery playout age',
    metrics.postRecoveryPlayoutAgeMaxMs,
    LIMITS.postRecoveryPlayoutAgeMaxMs,
  )
  requireMinimum(
    failures,
    'injected audio scheduled age',
    metrics.injectedAudioScheduledAgeMaxMs,
    LIMITS.injectedAudioScheduledAgeMinMs,
  )
  requireMaximum(
    failures,
    'release request latency',
    metrics.releaseRequestLatencyMaxMs,
    LIMITS.releaseRequestLatencyMaxMs,
  )
  requireMinimum(
    failures,
    'injected release retirement recovery',
    metrics.injectedReleaseRetirementRecoveries,
    2,
  )
  requireMaximum(
    failures,
    'injected release recovery duration',
    metrics.injectedReleaseRecoveryDurationMaxMs,
    LIMITS.injectedReleaseRecoveryDurationMaxMs,
  )
  requireExact(
    failures,
    'uncorrelated release retirement',
    metrics.uncorrelatedReleaseRetirements,
    0,
  )
  requireMinimum(
    failures,
    'injected renderer fence latency',
    metrics.injectedRendererFenceLatencyMaxMs,
    LIMITS.injectedRendererFenceLatencyMinMs,
  )
  requireMinimum(
    failures,
    'screen capture frames',
    metrics.screenCaptureFrames,
    LIMITS.screenCaptureFramesMin,
  )
  requireMinimum(
    failures,
    'screen capture cadence evidence',
    metrics.screenCadenceFps,
    0,
  )
  requireMinimum(
    failures,
    'ordinary screen capture cadence',
    metrics.screenOrdinaryCadenceFps,
    LIMITS.screenCadenceFpsMin,
  )
  requireMaximum(
    failures,
    'screen cadence gap',
    metrics.screenCadenceGapMaxMs,
    LIMITS.screenCadenceGapMaxMs,
  )
  const requiredScreenChurn = Math.max(
    1,
    Math.floor(
      (profile.durationMs - 1) / profile.screenBackendChurnIntervalMs,
    ),
  )
  requireMinimum(
    failures,
    'screen backend churn',
    metrics.screenBackendChurnCount,
    requiredScreenChurn,
  )
  requireMaximum(
    failures,
    'screen backend churn recovery',
    metrics.screenBackendChurnRecoveryMaxMs,
    LIMITS.screenBackendChurnRecoveryMaxMs,
  )
  requireMaximum(
    failures,
    'screen backend churn storm',
    metrics.screenBackendChurnCount,
    requiredScreenChurn + 2,
  )
  requireMaximum(
    failures,
    'screen recoverable transitions',
    metrics.screenRecoverableTransitions,
    LIMITS.screenRecoverableTransitions,
  )
  requireMaximum(
    failures,
    'screen GPU slot timeouts',
    metrics.screenGpuSlotTimeouts,
    // Each deliberate backend retirement may quarantine one conversion that
    // was already submitted. The fixed allowance catches unrelated steady-
    // state timeouts while the churn allowance prevents the test itself from
    // being classified as a timeout storm.
    LIMITS.screenGpuSlotTimeouts + requiredScreenChurn,
  )
  requireMaximum(
    failures,
    'screen GPU pool rollovers',
    metrics.screenGpuPoolRollovers,
    LIMITS.screenGpuPoolRollovers,
  )
  requireMaximum(
    failures,
    'screen capture reset count',
    metrics.screenCaptureResetCount,
    LIMITS.screenCaptureResetCount,
  )
  requireExact(
    failures,
    'screen capture resource baseline captured',
    metrics.screenResourceBaselineCaptured,
    1,
  )
  requireMaximum(
    failures,
    'screen capture thread-count delta',
    metrics.screenThreadDeltaMax,
    LIMITS.screenThreadDeltaMax,
  )
  requireMaximum(
    failures,
    'screen capture handle-count delta',
    metrics.screenHandleDeltaMax,
    LIMITS.screenHandleDeltaMax,
  )
  requireMinimum(
    failures,
    'competing workload cadence',
    metrics.competingWorkloadFps,
    PRIORITY_COMPETING_LIMITS.framesPerSecondMin,
  )
  requireMaximum(
    failures,
    'competing workload p95',
    metrics.competingWorkloadP95Ms,
    PRIORITY_COMPETING_LIMITS.p95MsMax,
  )
  requireMaximum(
    failures,
    'competing workload p99',
    metrics.competingWorkloadP99Ms,
    PRIORITY_COMPETING_LIMITS.p99MsMax,
  )
  requireMaximum(
    failures,
    'thread-count delta',
    metrics.threadDeltaMax,
    LIMITS.threadDeltaMax,
  )
  requireExact(
    failures,
    'resource baseline captured',
    metrics.resourceBaselineCaptured,
    1,
  )
  requireExact(
    failures,
    'final thread-count delta',
    metrics.threadDeltaFinal,
    0,
  )
  requireMaximum(
    failures,
    'handle-count delta',
    metrics.handleDeltaMax,
    LIMITS.handleDeltaMax,
  )
  requireMaximum(
    failures,
    'pending operations',
    metrics.pendingOperationsMax,
    LIMITS.pendingOperationsMax,
  )
  requireExact(failures, 'final pending operations', metrics.finalPendingOperations, 0)
  requireMaximum(
    failures,
    'active generations',
    metrics.maximumActiveGenerations,
    LIMITS.maximumActiveGenerations,
  )
  requireMaximum(
    failures,
    'quarantined generations',
    metrics.maximumQuarantinedGenerations,
    LIMITS.maximumQuarantinedGenerations,
  )
  requireMaximum(
    failures,
    'active backends',
    metrics.maximumActiveBackends,
    LIMITS.maximumActiveBackends,
  )
  requireMaximum(
    failures,
    'quarantined backends',
    metrics.maximumQuarantinedBackends,
    LIMITS.maximumQuarantinedBackends,
  )
  requireMaximum(
    failures,
    'approximate GPU allocation',
    metrics.approximateGpuBytesMax,
    LIMITS.approximateGpuBytesMax,
  )
  requireMinimum(
    failures,
    'renderer fence blocked transitions',
    metrics.rendererFenceBlockedTransitions,
    1,
  )
  requireMinimum(
    failures,
    'GPU fault armed after held frame',
    metrics.gpuFaultArmedAfterHeld,
    1,
  )
  requireExact(
    failures,
    'rollover while renderer fence held',
    metrics.rolloverWhileHeldProofs,
    1,
  )
  requireMinimum(
    failures,
    'forced GPU completion timeouts',
    metrics.gpuFaultForcedTimeouts,
    1,
  )
  requireMaximum(
    failures,
    'forced GPU completion timeouts',
    metrics.gpuFaultForcedTimeouts,
    4,
  )
  requireExact(
    failures,
    'renderer blocked timed wakeups',
    metrics.rendererBlockedTimedWakeups,
    0,
  )
  requireMinimum(
    failures,
    'remote video pool rollovers',
    metrics.remoteVideoPoolRollovers,
    1,
  )
  requireMaximum(
    failures,
    'remote video pool rollovers',
    metrics.remoteVideoPoolRollovers,
    LIMITS.resetCount,
  )
  requireMinimum(
    failures,
    'configured remote GPU backing',
    metrics.configuredRemoteGpuBytesMax,
    linkedPublicationGpuBytes(metrics),
  )
  requireMaximum(
    failures,
    'configured remote GPU backing',
    metrics.configuredRemoteGpuBytesMax,
    LIMITS.approximateGpuBytesMax,
  )
  requireMinimum(
    failures,
    'remote GPU generations',
    metrics.maximumRemoteGpuGenerations,
    2,
  )
  requireMaximum(
    failures,
    'remote GPU generations',
    metrics.maximumRemoteGpuGenerations,
    LIMITS.maximumRemoteGpuGenerations,
  )
  requireMinimum(
    failures,
    'remote shared-handle imports',
    metrics.remoteHandleImports,
    3,
  )
  requireMinimum(
    failures,
    'remote authoritative fence acknowledgements',
    metrics.remoteFenceAcks,
    1,
  )
  requireMinimum(
    failures,
    'camera preview shared-handle imports',
    metrics.cameraPreviewHandleImports,
    2,
  )
  requireMinimum(
    failures,
    'camera preview delayed fence',
    metrics.cameraPreviewDelayedFenceHits,
    1,
  )
  requireExact(
    failures,
    'camera preview renderer loss',
    metrics.cameraPreviewRendererLosses,
    1,
  )
  requireMinimum(
    failures,
    'fresh camera preview frame after renderer loss',
    metrics.cameraPreviewFreshFramesAfterLoss,
    1,
  )
  requireMinimum(
    failures,
    'camera preview fence acknowledgements',
    metrics.cameraPreviewFenceAcks,
    2,
  )
  requireExact(
    failures,
    'camera preview release failures',
    metrics.cameraPreviewReleaseFailures,
    0,
  )
  requireExact(
    failures,
    'final camera preview frames',
    metrics.finalCameraPreviewFrames,
    0,
  )
  requireExact(
    failures,
    'final camera preview usage bytes',
    metrics.finalCameraPreviewUsageBytes,
    0,
  )
  requireExact(
    failures,
    'final camera preview usage generations',
    metrics.finalCameraPreviewUsageGenerations,
    0,
  )
  requireMinimum(
    failures,
    'fresh frame after recovery',
    metrics.freshFramesAfterRecovery,
    1,
  )
  requireMinimum(failures, 'renderer reload', metrics.rendererReloadCount, 1)
  requireExact(
    failures,
    'renderer-fence host recycle',
    metrics.rendererFenceHostRecycles,
    1,
  )
  requireExact(
    failures,
    'voice-control timeout recycle',
    metrics.voiceControlTimeoutRecycles,
    1,
  )
  requireMinimum(failures, 'remote demand removal', metrics.demandRemovals, 1)
  requireExact(
    failures,
    'final remote renderer leases',
    metrics.finalRemoteRendererLeases,
    0,
  )
  requireExact(failures, 'final remote usage bytes', metrics.finalRemoteUsageBytes, 0)
  requireExact(
    failures,
    'final remote usage generations',
    metrics.finalRemoteUsageGenerations,
    0,
  )
  requireExact(
    failures,
    'final Electron in-flight textures',
    metrics.finalElectronInFlightTextures,
    0,
  )
  requireExact(
    failures,
    'final Electron retained texture bytes',
    metrics.finalElectronRetainedTextureBytes,
    0,
  )
  requireExact(
    failures,
    'premature texture reuse',
    metrics.prematureTextureReuse,
    0,
  )
  requireMaximum(
    failures,
    'reset storm',
    metrics.resetCount,
    LIMITS.resetCount,
  )
  requireMaximum(
    failures,
    'republish storm',
    metrics.republishCount,
    LIMITS.republishCount,
  )
  requireExact(failures, 'final held leases', metrics.finalHeldLeases, 0)

  const linkedVideoPipeline = metrics.linkedVideoPipeline
  const linkedFrameIds = [
    linkedVideoPipeline?.captureFrameId,
    linkedVideoPipeline?.encodedFrameId,
    linkedVideoPipeline?.publicationFrameId,
    linkedVideoPipeline?.remoteFrameId,
    linkedVideoPipeline?.electronFrameId,
  ]
  if (linkedFrameIds.some((frameId) =>
    typeof frameId !== 'string' || frameId.length === 0)) {
    failures.push('linked video pipeline proof is missing')
  } else if (
    linkedFrameIds.some((frameId) => frameId !== linkedFrameIds[0]) ||
    !Number.isSafeInteger(linkedVideoPipeline.nativeCaptureTimestampUs) ||
    linkedVideoPipeline.nativeCaptureTimestampUs <= 0 ||
    linkedVideoPipeline.remoteCaptureTimestampUs !==
      linkedVideoPipeline.nativeCaptureTimestampUs
  ) {
    failures.push(
      'linked video pipeline identity/timestamp did not survive capture, publication, remote viewer, and Electron presentation',
    )
  }
  const linkedRoomFields = [
    linkedVideoPipeline?.roomName,
    linkedVideoPipeline?.publisherIdentity,
    linkedVideoPipeline?.viewerIdentity,
    linkedVideoPipeline?.publicationSid,
    linkedVideoPipeline?.remoteTrackSid,
  ]
  if (linkedRoomFields.some((value) =>
    typeof value !== 'string' || value.length === 0) ||
    linkedVideoPipeline?.publicationSid !== linkedVideoPipeline?.remoteTrackSid) {
    failures.push(
      'linked video pipeline did not prove distinct LiveKit room participants and one subscribed publication',
    )
  }

  const remoteAudioPlayout = metrics.remoteAudioPlayout
  if (
    remoteAudioPlayout?.protocolVersion !== 1 ||
    typeof remoteAudioPlayout?.trackId !== 'string' ||
    remoteAudioPlayout.trackId.length === 0 ||
    !Number.isSafeInteger(remoteAudioPlayout.ingressFrames) ||
    remoteAudioPlayout.ingressFrames <= 0 ||
    !Number.isSafeInteger(remoteAudioPlayout.rendererFillCallbacks) ||
    remoteAudioPlayout.rendererFillCallbacks <= 0 ||
    !Number.isSafeInteger(remoteAudioPlayout.renderedSamples) ||
    remoteAudioPlayout.renderedSamples <= 0 ||
    !Number.isSafeInteger(remoteAudioPlayout.linkedRoomEpochs) ||
    remoteAudioPlayout.linkedRoomEpochs <= 0 ||
    remoteAudioPlayout.trackFailures !== 0
  ) {
    failures.push(
      'remote audio playout proof is missing tracked renderer fills',
    )
  } else if (
    remoteAudioPlayout.injectedWakeGaps !==
      REQUIRED_FAULT_HITS.audioSchedulingGap ||
    remoteAudioPlayout.recoveredWakeGaps !==
      remoteAudioPlayout.injectedWakeGaps
  ) {
    failures.push('renderer wake-gap recovery did not complete')
  }

  const audioRecoverySamples = Array.isArray(metrics.audioRecoverySamples)
    ? metrics.audioRecoverySamples
    : []
  const exactAudioIndexes = audioRecoverySamples.length === 4 &&
    audioRecoverySamples.every((sample, index) =>
      sample?.index === index &&
      Number.isFinite(sample.scheduledPlayoutAgeUs) &&
      sample.scheduledPlayoutAgeUs >= 0)
  if (!exactAudioIndexes) {
    failures.push('audio recovery samples must contain exact indexes 0 through 3')
  }
  requireExact(
    failures,
    'audio recovery settled inside the ordinary 80 ms limit',
    metrics.audioRecoverySettled,
    1,
  )
  requireExact(
    failures,
    'audio recovery arm after renderer reopen',
    metrics.audioRecoveryArmed,
    1,
  )

  const faultHits = { ...evidence.faultHits }
  for (const [fault, required] of Object.entries(REQUIRED_FAULT_HITS)) {
    requireMinimum(failures, `${fault} fault hits`, faultHits[fault], required)
  }
  if (!hasCorrelatedAnomaly(evidence.timeline)) {
    failures.push('correlated #45 timeline has no anomaly observation')
  }

  return {
    status: blockers.length > 0
      ? 'blocked'
      : failures.length > 0
        ? 'failed'
        : 'pass',
    blockers,
    blockerDetails,
    failures,
    faultHits,
    metrics: { ...metrics },
  }
}

function evaluatePriorityOutcome(outcome, failures) {
  const thread = outcome.captureThread
  if (
    !thread ||
    thread.succeeded !== true ||
    thread.applied !== thread.requested
  ) {
    failures.push(
      `capture thread priority failed with Win32 ${String(
        thread?.win32Error,
      )}`,
    )
  }

  const mmcss = outcome.captureMmcss
  if (
    !mmcss ||
    Boolean(mmcss.registered) !== Boolean(mmcss.requested)
  ) {
    failures.push(
      `capture MMCSS priority failed with Win32 ${String(mmcss?.win32Error)}`,
    )
  }

  for (const [label, field] of [
    ['publication D3D', outcome.publicationD3d],
    ['preview D3D', outcome.previewD3d],
  ]) {
    if (field && field.hresult === 0 && field.applied === field.requested) {
      continue
    }
    failures.push(
      `${label} priority failed with HRESULT ${String(field?.hresult)}`,
    )
  }
}

function buildContentionArtifact(evidence, options = {}) {
  const maximumBytes = positiveInteger(
    options.maximumBytes,
    evidence.profile?.maximumArtifactBytes ?? 512 * 1024,
  )
  const maximumTimelineRecords = positiveInteger(
    options.maximumTimelineRecords,
    evidence.profile?.maximumTimelineRecords ?? 2_048,
  )
  const aliases = new Map()
  const sanitizedTimeline = (evidence.timeline ?? []).map((record) =>
    sanitizeTimelineRecord(record, aliases),
  )
  const anomalies = sanitizedTimeline.filter(isAnomaly)
  const ordinary = sanitizedTimeline.filter((record) => !isAnomaly(record))
  const keepAnomalies = anomalies.slice(-maximumTimelineRecords)
  const ordinaryCapacity = Math.max(
    0,
    maximumTimelineRecords - keepAnomalies.length,
  )
  let timeline = [
    ...keepAnomalies,
    ...ordinary.slice(-ordinaryCapacity),
  ].sort(compareTimelineRecords)
  const artifact = {
    schema: 'syrnike.media-contention',
    version: 2,
    profile: sanitizeValue(evidence.profile, aliases),
    environment: sanitizeValue(evidence.environment, aliases),
    audioPolicyMatrix: sanitizeValue(evidence.audioPolicyMatrix, aliases),
    priorityOutcome: sanitizeValue(evidence.priorityOutcome, aliases),
    priorityDiagnostics: sanitizeValue(evidence.priorityDiagnostics, aliases),
    result: evaluateContentionRun(evidence),
    timeline,
  }
  while (
    Buffer.byteLength(JSON.stringify(artifact)) > maximumBytes &&
    artifact.timeline.length > 0
  ) {
    const ordinaryIndex = artifact.timeline.findIndex(
      (record) => !isAnomaly(record),
    )
    artifact.timeline.splice(ordinaryIndex >= 0 ? ordinaryIndex : 0, 1)
  }
  if (Buffer.byteLength(JSON.stringify(artifact)) > maximumBytes) {
    artifact.environment = {
      platform: evidence.environment?.platform ?? 'unknown',
      artifactTruncated: true,
    }
    artifact.result.failures = artifact.result.failures.slice(0, 16)
    artifact.result.blockers = artifact.result.blockers.slice(0, 16)
  }
  if (Buffer.byteLength(JSON.stringify(artifact)) > maximumBytes) {
    artifact.audioPolicyMatrix = {
      schema: evidence.audioPolicyMatrix?.schema,
      version: evidence.audioPolicyMatrix?.version,
      scenarioCount: evidence.audioPolicyMatrix?.scenarios?.length ?? 0,
      artifactTruncated: true,
    }
  }
  if (Buffer.byteLength(JSON.stringify(artifact)) > maximumBytes) {
    throw new Error(
      `contention artifact summary exceeds its ${maximumBytes}-byte bound`,
    )
  }
  return artifact
}

function evaluateAudioPolicyMatrix(evidence, addBlocker, failures) {
  const matrix = evidence.audioPolicyMatrix
  if (!matrix) {
    const reason = evidence.environment?.capabilities?.audioPolicyMatrix?.reason
    addBlocker(
      'audio_policy_matrix_unavailable',
      `audio policy matrix: ${reason ||
        'no --audio-policy-result hook evidence was provided'}`,
    )
    return
  }
  if (
    matrix.schema !== 'syrnike.windows-audio-policy-matrix' ||
    matrix.version !== 1 ||
    !Array.isArray(matrix.scenarios)
  ) {
    failures.push('audio policy matrix has an unsupported schema')
    return
  }

  const requirements = [
    ['warm_microphone', 'microphoneCaptureCategory', 'other'],
    ['remote_render', 'renderDuckingOptOut', 'applied'],
    ['screen_audio', 'screenCaptureCategory', 'other'],
    ['combined', 'microphoneCaptureCategory', 'other'],
    ['combined', 'screenCaptureCategory', 'other'],
    ['combined', 'renderDuckingOptOut', 'applied'],
  ]
  for (const endpoint of ['default', 'explicit']) {
    for (const mode of [
      'warm_microphone',
      'remote_render',
      'screen_audio',
      'combined',
    ]) {
      const scenario = matrix.scenarios.find(
        (entry) => entry?.mode === mode && entry?.endpoint === endpoint,
      )
      if (!scenario) {
        failures.push(
          `audio policy matrix is missing ${mode}/${endpoint}`,
        )
        continue
      }
      if (scenario.status === 'blocked') {
        addBlocker(
          'audio_policy_scenario_blocked',
          `audio policy ${mode}/${endpoint}: ${scenario.reason ||
            'environment capability was blocked'}`,
        )
        continue
      }
      if (scenario.status !== 'pass') {
        failures.push(`audio policy ${mode}/${endpoint} did not pass`)
      }
      for (const [requiredMode, field, expected] of requirements) {
        if (requiredMode !== mode) continue
        if (scenario[field] === expected) continue
        const label = field === 'renderDuckingOptOut'
          ? 'render ducking opt-out'
          : 'non-communications capture category'
        failures.push(
          `audio policy ${mode}/${endpoint} ${label} was not applied`,
        )
      }
      if (evidence.profile.name === 'production') {
        requireStableVolume(
          failures,
          `${mode}/${endpoint} system volume`,
          scenario.systemVolumeBefore,
          scenario.systemVolumeAfter,
        )
        requireStableVolume(
          failures,
          `${mode}/${endpoint} reference-app session volume`,
          scenario.referenceSessionVolumeBefore,
          scenario.referenceSessionVolumeAfter,
        )
      }
    }
  }

  if (!matrix.bluetooth || typeof matrix.bluetooth.available !== 'boolean') {
    failures.push('Bluetooth audio-policy outcome must be explicit')
  } else if (!matrix.bluetooth.available) {
    if (matrix.bluetooth.reason) {
      addBlocker(
        matrix.bluetooth.status === 'blocked' &&
          matrix.bluetooth.reasonCode === 'bluetooth_endpoint_pair_absent'
          ? 'bluetooth_endpoint_pair_absent'
          : 'bluetooth_audio_unavailable',
        `Bluetooth audio-policy matrix: ${matrix.bluetooth.reason}`,
      )
    } else {
      failures.push('Bluetooth audio-policy blocker has no reason')
    }
  } else if (matrix.bluetooth.status !== 'pass') {
    failures.push('Bluetooth audio-policy scenario did not pass')
  }

  const restart = matrix.runtimeRestart
  if (restart?.status === 'blocked') {
    addBlocker(
      'audio_policy_restart_blocked',
      `audio policy runtime restart: ${restart.reason ||
        'environment capability was blocked'}`,
    )
  } else if (restart?.status !== 'pass' || restart.policiesReapplied !== true) {
    failures.push('audio policy runtime restart did not reapply policies')
  }
}

function requireStableVolume(failures, label, before, after) {
  if (
    !Number.isFinite(before) ||
    !Number.isFinite(after) ||
    Math.abs(before - after) > 1e-6
  ) {
    failures.push(`${label} changed or was not observed`)
  }
}

function sanitizeTimelineRecord(record, aliases) {
  const sanitized = sanitizeValue(record, aliases)
  if (record?.participantIdentity) {
    sanitized.peerAlias = aliasFor(aliases, String(record.participantIdentity))
    delete sanitized.participantIdentity
  }
  return sanitized
}

function sanitizeValue(value, aliases, key = '') {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (/token|secret|password|credential/i.test(key)) return '[redacted]'
    if (/identity/i.test(key)) return aliasFor(aliases, value)
    return value.length > 1_024 ? `${value.slice(0, 1_024)}…` : value
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.slice(-8_192).map((entry) => sanitizeValue(entry, aliases))
  }
  const result = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    result[entryKey] = sanitizeValue(entryValue, aliases, entryKey)
  }
  return result
}

function aliasFor(aliases, identity) {
  let alias = aliases.get(identity)
  if (!alias) {
    alias = `peer-${aliases.size + 1}`
    aliases.set(identity, alias)
  }
  return alias
}

function hasCorrelatedAnomaly(timeline = []) {
  return timeline.some(
    (record) =>
      isAnomaly(record) &&
      typeof record.sessionId === 'string' &&
      Number.isSafeInteger(record.generation) &&
      typeof record.trackId === 'string' &&
      Number.isSafeInteger(record.frameSequence) &&
      Number.isSafeInteger(record.nativeCaptureTimestampUs) &&
      Number.isSafeInteger(record.runtimeEpoch),
  )
}

function isAnomaly(record) {
  return Boolean(
    record?.anomaly ||
      record?.reason ||
      /timeout|recovery|recycled/.test(String(record?.stage ?? '')),
  )
}

function compareTimelineRecords(left, right) {
  return (
    (left.nativeCaptureTimestampUs ?? left.timestampMs ?? 0) -
    (right.nativeCaptureTimestampUs ?? right.timestampMs ?? 0)
  )
}

function requireMinimum(failures, name, value, minimum) {
  if (!Number.isFinite(value) || value < minimum) {
    failures.push(`${name} ${String(value)} is below ${minimum}`)
  }
}

function linkedPublicationGpuBytes(metrics) {
  const width = Number(metrics?.linkedVideoPipeline?.publicationWidth)
  const height = Number(metrics?.linkedVideoPipeline?.publicationHeight)
  const generations = Number(metrics?.maximumRemoteGpuGenerations)
  if (!Number.isSafeInteger(width) || width <= 0 ||
      !Number.isSafeInteger(height) || height <= 0 ||
      !Number.isSafeInteger(generations) || generations <= 0) {
    return Number.NaN
  }
  const required = width * height * 4 * REMOTE_VIDEO_POOL_SLOTS * generations
  return Number.isSafeInteger(required) ? required : Number.NaN
}

function requireMaximum(failures, name, value, maximum) {
  if (!Number.isFinite(value) || value > maximum) {
    failures.push(`${name} ${String(value)} exceeds ${maximum}`)
  }
}

function requireExact(failures, name, value, expected) {
  if (value !== expected) {
    failures.push(`${name} ${String(value)} must equal ${expected}`)
  }
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

module.exports = {
  PRIORITY_COMPETING_LIMITS,
  REQUIRED_FAULT_HITS,
  buildContentionArtifact,
  contentionProbeRestartDelayMs,
  evaluateContentionRun,
  linkedVideoReadyDeadlineMs,
  resolveContentionProfile,
}
