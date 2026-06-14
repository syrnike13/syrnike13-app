import type { SoundEventPackId } from './sound-packs'
import { isSoundEventPackId } from './sound-packs'

type SoundRuntimeConfig = {
  eventPackId: SoundEventPackId | null
}

let state: SoundRuntimeConfig = {
  eventPackId: null,
}

export const soundRuntimeConfigStore = {
  getState: () => state,

  setEventPackId(eventPackId: unknown) {
    state = {
      eventPackId: isSoundEventPackId(eventPackId) ? eventPackId : null,
    }
  },
}
