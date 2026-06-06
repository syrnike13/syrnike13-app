import type {
  NativeCaptureFrameMethod,
  NativeCaptureFrameStats,
} from '@syrnike13/platform'

export type NativeCaptureDebugState = {
  backend: 'native' | 'chromium'
  methods: NativeCaptureFrameStats
  activeMethod?: NativeCaptureFrameMethod
}

const emptyMethods = (): NativeCaptureFrameStats => ({
  wgc: 0,
  dxgi: 0,
  gdi_blt: 0,
  gdi_print: 0,
})

let state: NativeCaptureDebugState = {
  backend: 'chromium',
  methods: emptyMethods(),
}

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export const nativeCaptureStatsStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getState: () => state,
  setNative(
    methods: NativeCaptureFrameStats,
    activeMethod?: NativeCaptureFrameMethod,
  ) {
    state = {
      backend: 'native',
      methods: { ...methods },
      activeMethod,
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
