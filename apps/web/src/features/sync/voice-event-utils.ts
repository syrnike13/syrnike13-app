import type {
  ChannelVoiceState,
  UserVoiceState,
  VoiceParticipantsByChannel,
} from './voice-types'
import { isValidVoiceUserId } from './voice-participant-resolve'

function parseJoinedAt(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

/** API/WS иногда отдают 0/1 или строки — не через `Boolean("false")`. */
export function parseVoiceFlag(value: unknown, defaultValue: boolean) {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  if (value === undefined || value === null) return defaultValue
  return Boolean(value)
}

export function normalizeUserVoiceState(
  raw: Partial<UserVoiceState> & {
    user?: string
    user_id?: string
  },
): UserVoiceState | null {
  const id = raw.id ?? raw.user ?? raw.user_id
  if (!id || !isValidVoiceUserId(id)) return null

  return {
    id,
    joined_at: parseJoinedAt(raw.joined_at),
    is_receiving: parseVoiceFlag(raw.is_receiving, true),
    is_publishing: parseVoiceFlag(raw.is_publishing, true),
    screensharing: Boolean(raw.screensharing ?? false),
    camera: Boolean(raw.camera ?? false),
  }
}

export function channelIdFromVoiceStateEntry(
  entry: ChannelVoiceState & { channel_id?: string; channel?: string },
) {
  return entry.id ?? entry.channel_id ?? entry.channel
}

/** Не затираем store при `Ready` с пустым `voice_states: []`. */
export function mergeVoiceStatesFromReady(
  existing: VoiceParticipantsByChannel,
  voiceStates:
    | Array<ChannelVoiceState & { channel_id?: string; channel?: string }>
    | undefined,
): VoiceParticipantsByChannel {
  if (voiceStates === undefined) return existing

  const next = { ...existing }
  const incoming = voiceMapFromChannelStates(voiceStates)
  for (const [channelId, channelMap] of Object.entries(incoming)) {
    next[channelId] = channelMap
  }
  return next
}

export function voiceMapFromChannelStates(
  voiceStates: Array<ChannelVoiceState & { channel_id?: string }> | undefined,
) {
  if (!voiceStates?.length) return {} as Record<string, Record<string, UserVoiceState>>

  const map: Record<string, Record<string, UserVoiceState>> = {}
  for (const entry of voiceStates) {
    const channelId = channelIdFromVoiceStateEntry(entry)
    if (!channelId) continue

    const channelMap: Record<string, UserVoiceState> = {}
    const rawParticipants =
      entry.participants ??
      (entry as ChannelVoiceState & { users?: unknown[] }).users ??
      []
    for (const participant of rawParticipants) {
      const normalized =
        typeof participant === 'string'
          ? normalizeUserVoiceState({ id: participant })
          : normalizeUserVoiceState(
              participant as Partial<UserVoiceState> & {
                user?: string
                user_id?: string
              },
            )
      if (normalized) channelMap[normalized.id] = normalized
    }
    map[channelId] = channelMap
  }
  return map
}
