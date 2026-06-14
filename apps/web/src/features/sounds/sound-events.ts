export const UI_SOUND_EVENTS = [
  'message.default',
  'message.mention',
  'message.reaction',
  'voice.user_join',
  'voice.user_leave',
  'voice.user_move',
  'voice.mute',
  'voice.unmute',
  'voice.deafen',
  'voice.undeafen',
  'voice.disconnect',
  'call.incoming_ring',
  'call.outgoing_ring',
  'call.connected',
  'call.ended',
  'screen_share.started',
  'screen_share.stopped',
  'camera.started',
  'camera.stopped',
] as const

export type SoundEventId = (typeof UI_SOUND_EVENTS)[number]
