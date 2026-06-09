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

function parseVersion(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
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
    self_mute: parseVoiceFlag(raw.self_mute, false),
    self_deaf: parseVoiceFlag(raw.self_deaf, false),
    server_muted: parseVoiceFlag(raw.server_muted, false),
    server_deafened: parseVoiceFlag(raw.server_deafened, false),
    screensharing: Boolean(raw.screensharing ?? false),
    camera: Boolean(raw.camera ?? false),
    version: parseVersion(raw.version),
  }
}

export function channelIdFromVoiceStateEntry(
  entry: ChannelVoiceState & { channel_id?: string; channel?: string },
) {
  return entry.id ?? entry.channel_id ?? entry.channel
}

/** `Ready.voice_states` — авторитетный снимок всех голосовых каналов. */
export function mergeVoiceStatesFromReady(
  existing: VoiceParticipantsByChannel,
  voiceStates:
    | Array<ChannelVoiceState & { channel_id?: string; channel?: string }>
    | undefined,
): VoiceParticipantsByChannel {
  if (voiceStates === undefined) return existing
  return voiceMapFromChannelStates(voiceStates)
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

export function shouldApplyVoiceState(
  existing: UserVoiceState | undefined,
  incoming: UserVoiceState,
) {
  if (!existing) return true
  if (incoming.version > existing.version) return true
  if (incoming.version < existing.version) return false
  return incoming.joined_at > existing.joined_at
}
