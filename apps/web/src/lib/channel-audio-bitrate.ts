import type { Channel, DataEditChannel } from '@syrnike13/api-types'

export const MIN_VOICE_CHANNEL_AUDIO_BITRATE_KBPS = 8
export const MAX_VOICE_CHANNEL_AUDIO_BITRATE_KBPS = 96
export const DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS = 64

type VoiceInformation = NonNullable<
  Extract<Channel, { channel_type: 'TextChannel' }>['voice']
>

type ChannelWithVoiceSettings = {
  voice?: VoiceInformation | null
}

export function clampVoiceChannelAudioBitrateKbps(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS
  return Math.min(
    MAX_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
    Math.max(MIN_VOICE_CHANNEL_AUDIO_BITRATE_KBPS, Math.round(value)),
  )
}

export function channelAudioBitrateKbps(channel: ChannelWithVoiceSettings) {
  return clampVoiceChannelAudioBitrateKbps(
    channel.voice?.audio_bitrate_kbps ??
      DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
  )
}

export function channelAudioBitrateBps(channel: ChannelWithVoiceSettings) {
  return channelAudioBitrateKbps(channel) * 1000
}

export function buildVoiceChannelAudioBitratePatch(
  channel: ChannelWithVoiceSettings,
  bitrateKbps: number,
): Pick<DataEditChannel, 'voice'> {
  return {
    voice: {
      ...(channel.voice ?? {}),
      audio_bitrate_kbps: clampVoiceChannelAudioBitrateKbps(bitrateKbps),
    },
  }
}
