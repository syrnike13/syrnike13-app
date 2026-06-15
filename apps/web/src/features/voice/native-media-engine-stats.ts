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
  wgc: 0,
  dxgi: 0,
  gdi_blt: 0,
  gdi_print: 0,
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
