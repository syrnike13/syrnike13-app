import { useSyncExternalStore } from 'react'

import { voicePreferenceStore } from '#/features/voice/voice-preference-store'

export function useVoicePreferences() {
  return useSyncExternalStore(
    voicePreferenceStore.subscribe,
    () => voicePreferenceStore.getState(),
    () => voicePreferenceStore.getState(),
  )
}
