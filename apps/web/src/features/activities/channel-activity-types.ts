export const SHARED_COUNTER_APPLICATION_ID = 'syrnike13.shared-counter'
export const SYRNIK_RACE_APPLICATION_ID = 'syrnike13.syrnik-race'

export type ChannelActivityInstance = Readonly<{
  id: string
  application_id: string
  channel_id: string
  server_id?: string
  owner_id: string
  participant_ids: readonly string[]
  revision: number
  state: unknown
  created_at: string | number
}>

export type ChannelActivityErrorCode =
  | 'not_in_voice_channel'
  | 'unknown_application'
  | 'already_running'
  | 'instance_not_found'
  | 'not_participant'
  | 'not_owner'
  | 'invalid_command'
  | 'invalid_request'
  | 'internal'

export type ChannelActivityViewState = Readonly<{
  instance: ChannelActivityInstance | null
  error: ChannelActivityErrorCode | null
  transport: 'connected' | 'reconnecting' | 'disconnected'
}>

export function isChannelActivityInstance(
  value: unknown,
): value is ChannelActivityInstance {
  if (!value || typeof value !== 'object') return false
  const instance = value as Record<string, unknown>
  return (
    validIdentifier(instance.id) &&
    validIdentifier(instance.application_id) &&
    validIdentifier(instance.channel_id) &&
    (instance.server_id === undefined || validIdentifier(instance.server_id)) &&
    validIdentifier(instance.owner_id) &&
    Array.isArray(instance.participant_ids) &&
    instance.participant_ids.every(validIdentifier) &&
    Number.isSafeInteger(instance.revision) &&
    Number(instance.revision) >= 1 &&
    (typeof instance.created_at === 'string' ||
      typeof instance.created_at === 'number')
  )
}

export function isChannelActivityErrorCode(
  value: unknown,
): value is ChannelActivityErrorCode {
  return (
    value === 'not_in_voice_channel' ||
    value === 'unknown_application' ||
    value === 'already_running' ||
    value === 'instance_not_found' ||
    value === 'not_participant' ||
    value === 'not_owner' ||
    value === 'invalid_command' ||
    value === 'invalid_request' ||
    value === 'internal'
  )
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}
