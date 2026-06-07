import type {
  NativeMediaFrameMethod,
  NativeMediaFrameStats,
} from '@syrnike13/platform'

export type NativeMediaEngineDebugState = {
  backend: 'native' | 'chromium'
  methods: NativeMediaFrameStats
  activeMethod?: NativeMediaFrameMethod
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
