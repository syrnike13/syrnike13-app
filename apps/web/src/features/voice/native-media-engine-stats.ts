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
  videoAvgCaptureUs?: number
}

const emptyMethods = (): NativeMediaFrameStats => ({
  wgc: 0,
  dxgi: 0,
  gdi_blt: 0,
  gdi_print: 0,
})

let state: NativeMediaEngineDebugState = {
  backend: 'chromium',
  methods: emptyMethods(),
}

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
      videoAvgCaptureUs?: number
    },
  ) {
    state = {
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
      videoAvgCaptureUs: video?.videoAvgCaptureUs,
    }
    emit()
  },
  setChromium() {
    state = { backend: 'chromium', methods: emptyMethods() }
    emit()
  },
  reset() {
    state = { backend: 'chromium', methods: emptyMethods() }
    emit()
  },
}
