import { Option, Schema } from 'effect'

import type { StageMediaFilters } from '#/features/voice/voice-stage-media'

export const STAGE_MEDIA_FILTERS_STORAGE_KEY =
  'syrnike13.voice.stageMediaFilters'

export const DEFAULT_STAGE_MEDIA_FILTERS: StageMediaFilters = {
  showOwnStream: true,
  showRemoteStreams: true,
  showParticipantsWithoutMedia: true,
}

const StageMediaFiltersSchema = Schema.Struct({
  showOwnStream: Schema.optionalKey(Schema.Boolean),
  showRemoteStreams: Schema.optionalKey(Schema.Boolean),
  showParticipantsWithoutMedia: Schema.optionalKey(Schema.Boolean),
})
const StageMediaFiltersJsonSchema = Schema.fromJsonString(
  StageMediaFiltersSchema,
)

export function readStageMediaFilters(): StageMediaFilters {
  if (typeof window === 'undefined') return DEFAULT_STAGE_MEDIA_FILTERS
  try {
    const raw = window.localStorage.getItem(STAGE_MEDIA_FILTERS_STORAGE_KEY)
    if (!raw) return DEFAULT_STAGE_MEDIA_FILTERS
    const decoded = Schema.decodeUnknownOption(StageMediaFiltersJsonSchema)(raw)
    return {
      ...DEFAULT_STAGE_MEDIA_FILTERS,
      ...Option.getOrElse(decoded, () => ({})),
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
      Schema.encodeSync(StageMediaFiltersJsonSchema)(filters),
    )
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('Failed to write stage media filters to localStorage', error)
    }
    // localStorage may be unavailable in private/browser-restricted contexts.
  }
}
