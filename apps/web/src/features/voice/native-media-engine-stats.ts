import type {
  NativeMediaAudioMode,
  NativeMediaFrameMethod,
  NativeMediaFrameStats,
  NativeMediaLoopbackMode,
} from '@syrnike13/platform'

export type NativeMediaEngineDebugState = {
  backend: 'native' | 'chromium'
  methods: NativeMediaFrameStats
  activeMethod?: NativeMediaFrameMethod
  audioMode?: NativeMediaAudioMode
  audioLoopbackMode?: NativeMediaLoopbackMode
  audioTargetProcessId?: number
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  publishedVideo?: boolean
  publishedAudio?: boolean
  audioFrames?: number
  audioPackets?: number
  audioPeakDb?: number
  audioRmsDb?: number
  videoFrames?: number
  videoIntervalFrames?: number
  videoLateFrames?: number
  videoNoFrameCount?: number
  videoRepeatedFrameCount?: number
  videoRecoverableLostCount?: number
  videoSourceUpdates?: number
  videoGpuSubmissions?: number
  videoIdleRefreshes?: number
  videoCoalescedSourceUpdates?: number
  videoEncoderBackpressureTicks?: number
  videoSupersededReadyFrames?: number
  videoGpuSlotTimeouts?: number
  videoGpuSlotsRecovered?: number
  videoGpuFramesDroppedStale?: number
  videoGpuPoolRollovers?: number
  videoGpuRolloversBlocked?: number
  videoGpuRetiredGenerations?: number
  videoGpuSlotsQuarantined?: number
  videoPreviewBridgeSubmissions?: number
  videoPreviewBridgeAcquires?: number
  videoPreviewBridgeTimeouts?: number
  videoPreviewBridgeSlotsRecovered?: number
  videoPreviewGpuSubmissions?: number
  videoPreviewFramesCompleted?: number
  videoPreviewSlotTimeouts?: number
  videoPreviewFramesDroppedStale?: number
  videoPreviewDeviceResets?: number
  videoGpuCompletionP50Us?: number
  videoGpuCompletionP95Us?: number
  videoGpuCompletionMaxUs?: number
  videoAvgCaptureUs?: number
  videoAvgReadbackUs?: number
  videoAvgScaleUs?: number
  videoAvgPublishUs?: number
  videoSourceWidth?: number
  videoSourceHeight?: number
  videoContentWidth?: number
  videoContentHeight?: number
  captureThreadMmcss?: boolean
}

const emptyMethods = (): NativeMediaFrameStats => ({
  wgc_gpu: 0,
  dxgi_gpu: 0,
})

function snapshot(
  next: NativeMediaEngineDebugState,
): NativeMediaEngineDebugState {
  return Object.freeze({
    ...next,
    methods: Object.freeze({ ...next.methods }),
  })
}

let state: NativeMediaEngineDebugState = snapshot({
  backend: 'chromium',
  methods: emptyMethods(),
})

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export const nativeMediaEngineStatsStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getState: () => state,
  setNative(
    methods: NativeMediaFrameStats,
    activeMethod?: NativeMediaFrameMethod,
    audio?: {
      mode?: NativeMediaAudioMode
      loopbackMode?: NativeMediaLoopbackMode
      targetProcessId?: number
    },
    video?: {
      width?: number
      height?: number
      fps?: number
      bitrate?: number
      publishedVideo?: boolean
      publishedAudio?: boolean
      audioFrames?: number
      audioPackets?: number
      audioPeakDb?: number
      audioRmsDb?: number
      videoFrames?: number
      videoIntervalFrames?: number
      videoLateFrames?: number
      videoNoFrameCount?: number
      videoRepeatedFrameCount?: number
      videoRecoverableLostCount?: number
      videoSourceUpdates?: number
      videoGpuSubmissions?: number
      videoIdleRefreshes?: number
      videoCoalescedSourceUpdates?: number
      videoEncoderBackpressureTicks?: number
      videoSupersededReadyFrames?: number
      videoGpuSlotTimeouts?: number
      videoGpuSlotsRecovered?: number
      videoGpuFramesDroppedStale?: number
      videoGpuPoolRollovers?: number
      videoGpuRolloversBlocked?: number
      videoGpuRetiredGenerations?: number
      videoGpuSlotsQuarantined?: number
      videoPreviewBridgeSubmissions?: number
      videoPreviewBridgeAcquires?: number
      videoPreviewBridgeTimeouts?: number
      videoPreviewBridgeSlotsRecovered?: number
      videoPreviewGpuSubmissions?: number
      videoPreviewFramesCompleted?: number
      videoPreviewSlotTimeouts?: number
      videoPreviewFramesDroppedStale?: number
      videoPreviewDeviceResets?: number
      videoGpuCompletionP50Us?: number
      videoGpuCompletionP95Us?: number
      videoGpuCompletionMaxUs?: number
      videoAvgCaptureUs?: number
      videoAvgReadbackUs?: number
      videoAvgScaleUs?: number
      videoAvgPublishUs?: number
      videoSourceWidth?: number
      videoSourceHeight?: number
      videoContentWidth?: number
      videoContentHeight?: number
      captureThreadMmcss?: boolean
    },
  ) {
    state = snapshot({
      backend: 'native',
      methods: { ...methods },
      activeMethod,
      audioMode: audio?.mode,
      audioLoopbackMode: audio?.loopbackMode,
      audioTargetProcessId: audio?.targetProcessId,
      width: video?.width,
      height: video?.height,
      fps: video?.fps,
      bitrate: video?.bitrate,
      publishedVideo: video?.publishedVideo,
      publishedAudio: video?.publishedAudio,
      audioFrames: video?.audioFrames,
      audioPackets: video?.audioPackets,
      audioPeakDb: video?.audioPeakDb,
      audioRmsDb: video?.audioRmsDb,
      videoFrames: video?.videoFrames,
      videoIntervalFrames: video?.videoIntervalFrames,
      videoLateFrames: video?.videoLateFrames,
      videoNoFrameCount: video?.videoNoFrameCount,
      videoRepeatedFrameCount: video?.videoRepeatedFrameCount,
      videoRecoverableLostCount: video?.videoRecoverableLostCount,
      videoSourceUpdates: video?.videoSourceUpdates,
      videoGpuSubmissions: video?.videoGpuSubmissions,
      videoIdleRefreshes: video?.videoIdleRefreshes,
      videoCoalescedSourceUpdates: video?.videoCoalescedSourceUpdates,
      videoEncoderBackpressureTicks: video?.videoEncoderBackpressureTicks,
      videoSupersededReadyFrames: video?.videoSupersededReadyFrames,
      videoGpuSlotTimeouts: video?.videoGpuSlotTimeouts,
      videoGpuSlotsRecovered: video?.videoGpuSlotsRecovered,
      videoGpuFramesDroppedStale: video?.videoGpuFramesDroppedStale,
      videoGpuPoolRollovers: video?.videoGpuPoolRollovers,
      videoGpuRolloversBlocked: video?.videoGpuRolloversBlocked,
      videoGpuRetiredGenerations: video?.videoGpuRetiredGenerations,
      videoGpuSlotsQuarantined: video?.videoGpuSlotsQuarantined,
      videoPreviewBridgeSubmissions: video?.videoPreviewBridgeSubmissions,
      videoPreviewBridgeAcquires: video?.videoPreviewBridgeAcquires,
      videoPreviewBridgeTimeouts: video?.videoPreviewBridgeTimeouts,
      videoPreviewBridgeSlotsRecovered: video?.videoPreviewBridgeSlotsRecovered,
      videoPreviewGpuSubmissions: video?.videoPreviewGpuSubmissions,
      videoPreviewFramesCompleted: video?.videoPreviewFramesCompleted,
      videoPreviewSlotTimeouts: video?.videoPreviewSlotTimeouts,
      videoPreviewFramesDroppedStale: video?.videoPreviewFramesDroppedStale,
      videoPreviewDeviceResets: video?.videoPreviewDeviceResets,
      videoGpuCompletionP50Us: video?.videoGpuCompletionP50Us,
      videoGpuCompletionP95Us: video?.videoGpuCompletionP95Us,
      videoGpuCompletionMaxUs: video?.videoGpuCompletionMaxUs,
      videoAvgCaptureUs: video?.videoAvgCaptureUs,
      videoAvgReadbackUs: video?.videoAvgReadbackUs,
      videoAvgScaleUs: video?.videoAvgScaleUs,
      videoAvgPublishUs: video?.videoAvgPublishUs,
      videoSourceWidth: video?.videoSourceWidth,
      videoSourceHeight: video?.videoSourceHeight,
      videoContentWidth: video?.videoContentWidth,
      videoContentHeight: video?.videoContentHeight,
      captureThreadMmcss: video?.captureThreadMmcss,
    })
    emit()
  },
  setChromium() {
    state = snapshot({ backend: 'chromium', methods: emptyMethods() })
    emit()
  },
  reset() {
    state = snapshot({ backend: 'chromium', methods: emptyMethods() })
    emit()
  },
}
