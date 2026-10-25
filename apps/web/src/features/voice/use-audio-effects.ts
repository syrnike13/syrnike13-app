import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AudioEffectSlot,
  AudioEffectSlotUpdate,
  AudioEffectsState,
  AudioEffectsStats,
  AudioPluginCatalog,
} from '@syrnike13/platform'

import { getSyrnikeDesktop } from '#/platform/runtime'

const STATS_INTERVAL_MS = 1_000

/** Desktop microphone effect chain; null state outside the Windows app. */
export function useAudioEffects() {
  const effects = getSyrnikeDesktop()?.audioEffects ?? null
  const [state, setState] = useState<AudioEffectsState | null>(null)
  const [catalog, setCatalog] = useState<AudioPluginCatalog | null>(null)
  const [stats, setStats] = useState<AudioEffectsStats | null>(null)
  const hostRunning = state?.host === 'running'
  const catalogRequested = useRef(false)

  useEffect(() => {
    if (!effects) return
    let live = true
    const offState = effects.onStateChange(next => setState(next))
    const offCatalog = effects.onCatalogChange(next => setCatalog(next))
    void effects.getState().then(next => { if (live) setState(next) }, () => undefined)
    void effects.getCatalog().then(next => { if (live) setCatalog(next) }, () => undefined)
    return () => {
      live = false
      offState()
      offCatalog()
    }
  }, [effects])

  // Load is sampled only while the effects settings are on screen.
  useEffect(() => {
    if (!effects || !hostRunning) {
      setStats(null)
      return
    }
    let live = true
    const poll = () => void effects.getStats().then(next => { if (live) setStats(next) }, () => undefined)
    poll()
    const timer = setInterval(poll, STATS_INTERVAL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [effects, hostRunning])

  const setChain = useCallback((slots: readonly AudioEffectSlot[]) => {
    if (!effects) return
    // Show the new order at once; the host answer replaces the statuses.
    setState(current => current ? { ...current, slots } : current)
    void effects.setChain(slots).then(setState, () => undefined)
  }, [effects])

  const updateSlot = useCallback((update: AudioEffectSlotUpdate) => {
    if (!effects) return
    setState(current => current ? {
      ...current,
      slots: current.slots.map(slot => {
        if (slot.slotId !== update.slotId) return slot
        const controls = {
          ...(update.mix === undefined ? {} : { mix: update.mix }),
          ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
        }
        return slot.kind === 'builtin'
          ? { ...slot, ...controls, params: { ...slot.params, ...update.params } }
          : { ...slot, ...controls }
      }),
    } : current)
    void effects.updateSlot(update).catch(() => undefined)
  }, [effects])

  const openEditor = useCallback((slotId: string) => {
    void effects?.openEditor(slotId).catch(() => undefined)
  }, [effects])

  const scanPlugins = useCallback(() => {
    void effects?.scanPlugins().catch(() => undefined)
  }, [effects])

  // A scan loads every installed plugin, so it runs once per mounted settings
  // screen and only when the plugin list is really opened, never as a side
  // effect of opening the voice settings or joining a call.
  const ensureCatalog = useCallback(() => {
    if (!effects || catalogRequested.current) return
    catalogRequested.current = true
    void effects.scanPlugins().catch(() => undefined)
  }, [effects])

  return {
    available: effects !== null, state, catalog, stats,
    setChain, updateSlot, openEditor, scanPlugins, ensureCatalog,
  }
}
