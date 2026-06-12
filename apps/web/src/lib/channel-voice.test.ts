import { describe, expect, it } from 'vitest'

import { channelHasVoice, isServerVoiceChannel } from './channel-voice'

describe('channel voice capabilities', () => {
  it('treats direct messages and groups as voice-capable without a voice field', () => {
    expect(
      channelHasVoice({
        _id: 'dm-channel',
        channel_type: 'DirectMessage',
        active: true,
        recipients: ['user-1', 'user-2'],
      } as never),
    ).toBe(true)

    expect(
      channelHasVoice({
        _id: 'group-channel',
        channel_type: 'Group',
        name: 'group',
        owner: 'user-1',
        recipients: ['user-1', 'user-2'],
      } as never),
    ).toBe(true)
  })

  it('does not treat direct messages and groups as server voice channels', () => {
    expect(
      isServerVoiceChannel({
        _id: 'dm-channel',
        channel_type: 'DirectMessage',
        active: true,
        recipients: ['user-1', 'user-2'],
      } as never),
    ).toBe(false)
  })
})
