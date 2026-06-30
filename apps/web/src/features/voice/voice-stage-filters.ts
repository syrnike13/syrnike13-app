import type { StageMediaFilters } from '#/features/voice/voice-stage-media'

export const STAGE_MEDIA_FILTERS_STORAGE_KEY =
  'syrnike13.voice.stageMediaFilters'

export const DEFAULT_STAGE_MEDIA_FILTERS: StageMediaFilters = {
  showOwnStream: true,
  showRemoteStreams: true,
  showParticipantsWithoutMedia: true,
}

export function readStageMediaFilters(): StageMediaFilters {
  if (typeof window === 'undefined') return DEFAULT_STAGE_MEDIA_FILTERS
  try {
    const raw = window.localStorage.getItem(STAGE_MEDIA_FILTERS_STORAGE_KEY)
    if (!raw) return DEFAULT_STAGE_MEDIA_FILTERS
    return {
      ...DEFAULT_STAGE_MEDIA_FILTERS,
      ...(JSON.parse(raw) as Partial<StageMediaFilters>),
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('Failed to read stage media filters from localStorage', error)
    }
    return DEFAULT_STAGE_MEDIA_FILTERS
  }
}

export function writeStageMediaFilters(filters: StageMediaFilters) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      STAGE_MEDIA_FILTERS_STORAGE_KEY,
      JSON.stringify(filters),
    )
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('Failed to write stage media filters to localStorage', error)
    }
    // localStorage may be unavailable in private/browser-restricted contexts.
  }
}
