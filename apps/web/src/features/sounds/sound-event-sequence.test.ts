import { describe, expect, it } from 'vitest'

import type { UserVoiceState } from '#/features/sync/voice-types'

import {
  createSoundEventResolver,
  currentVoiceChannelIdFromParticipants,
} from './sound-event-sequence'

const CURRENT_USER_ID = 'user-self'
const REMOTE_USER_ID = 'user-remote'
const VOICE_OPEN_ID = 'voice-open'
const VOICE_OTHER_ID = 'voice-other'

const baseContext = {
  currentUserId: CURRENT_USER_ID,
  activeChannelId: 'text-open',
  currentVoiceChannelId: VOICE_OPEN_ID,
  documentFocused: false,
  blockedUserIds: new Set<string>(),
}

function voiceState(
  id: string,
  overrides: Partial<UserVoiceState> = {},
): UserVoiceState {
  return {
    id,
    joined_at: 1,
    self_mute: false,
    self_deaf: false,
    server_muted: false,
    server_deafened: false,
    screensharing: false,
    camera: false,
    version: 1,
    ...overrides,
  }
}

describe('sound event sequence resolver', () => {
  it('detects the current voice channel from participant snapshots', () => {
    expect(
      currentVoiceChannelIdFromParticipants(
        {
          [VOICE_OTHER_ID]: {
            [REMOTE_USER_ID]: voiceState(REMOTE_USER_ID),
          },
          [VOICE_OPEN_ID]: {
            [CURRENT_USER_ID]: voiceState(CURRENT_USER_ID),
          },
        },
        CURRENT_USER_ID,
      ),
    ).toBe(VOICE_OPEN_ID)

    expect(currentVoiceChannelIdFromParticipants({}, CURRENT_USER_ID)).toBeNull()
    expect(currentVoiceChannelIdFromParticipants({}, null)).toBeNull()
  })

  it('plays screen share start once and ignores repeated active snapshots', () => {
    const resolver = createSoundEventResolver({
      [VOICE_OPEN_ID]: {
        [CURRENT_USER_ID]: voiceState(CURRENT_USER_ID),
        [REMOTE_USER_ID]: voiceState(REMOTE_USER_ID),
      },
    })

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: REMOTE_USER_ID, screensharing: true },
        },
        baseContext,
      ),
    ).toEqual(['screen_share.started'])

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: REMOTE_USER_ID, screensharing: true, self_mute: true },
        },
        baseContext,
      ),
    ).toEqual([])
  })

  it('plays screen share stop only after a known active stream in the current voice', () => {
    const resolver = createSoundEventResolver({
      [VOICE_OPEN_ID]: {
        [CURRENT_USER_ID]: voiceState(CURRENT_USER_ID),
        [REMOTE_USER_ID]: voiceState(REMOTE_USER_ID, { screensharing: true }),
      },
    })

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: REMOTE_USER_ID, screensharing: false },
        },
        baseContext,
      ),
    ).toEqual(['screen_share.stopped'])

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: REMOTE_USER_ID, screensharing: false },
        },
        baseContext,
      ),
    ).toEqual([])
  })

  it('does not replay local media updates from the server echo', () => {
    const resolver = createSoundEventResolver({
      [VOICE_OPEN_ID]: {
        [CURRENT_USER_ID]: voiceState(CURRENT_USER_ID),
      },
    })

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: CURRENT_USER_ID, screensharing: true },
        },
        baseContext,
      ),
    ).toEqual([])

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: CURRENT_USER_ID, screensharing: true },
        },
        baseContext,
      ),
    ).toEqual([])
  })

  it('plays camera stop only after a known active camera in the current voice', () => {
    const resolver = createSoundEventResolver({
      [VOICE_OPEN_ID]: {
        [CURRENT_USER_ID]: voiceState(CURRENT_USER_ID),
        [REMOTE_USER_ID]: voiceState(REMOTE_USER_ID, { camera: true }),
      },
    })

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: REMOTE_USER_ID, camera: false },
        },
        baseContext,
      ),
    ).toEqual(['camera.stopped'])

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: REMOTE_USER_ID, camera: false },
        },
        baseContext,
      ),
    ).toEqual([])
  })

  it('ignores screen and camera changes outside the current voice session', () => {
    const resolver = createSoundEventResolver({
      [VOICE_OPEN_ID]: {
        [CURRENT_USER_ID]: voiceState(CURRENT_USER_ID),
      },
      [VOICE_OTHER_ID]: {
        [REMOTE_USER_ID]: voiceState(REMOTE_USER_ID),
      },
    })

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OTHER_ID,
          state: { id: REMOTE_USER_ID, screensharing: true },
        },
        baseContext,
      ),
    ).toEqual([])

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: REMOTE_USER_ID, camera: true },
        },
        { ...baseContext, currentVoiceChannelId: null },
      ),
    ).toEqual([])
  })

  it('preserves cached media flags when a voice state update only changes one flag', () => {
    const resolver = createSoundEventResolver({
      [VOICE_OPEN_ID]: {
        [CURRENT_USER_ID]: voiceState(CURRENT_USER_ID),
        [REMOTE_USER_ID]: voiceState(REMOTE_USER_ID, { camera: true }),
      },
    })

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: REMOTE_USER_ID, screensharing: true },
        },
        baseContext,
      ),
    ).toEqual(['screen_share.started'])

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: REMOTE_USER_ID, camera: false },
        },
        baseContext,
      ),
    ).toEqual(['camera.stopped'])
  })

  it('does not replay sounds from Ready snapshots or subsequent identical updates', () => {
    const resolver = createSoundEventResolver()

    expect(
      resolver.resolve(
        {
          type: 'Ready',
          voice_states: [
            {
              id: VOICE_OPEN_ID,
              participants: [
                voiceState(CURRENT_USER_ID),
                voiceState(REMOTE_USER_ID, { screensharing: true }),
              ],
            },
          ],
        },
        baseContext,
      ),
    ).toEqual([])

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: REMOTE_USER_ID, screensharing: true },
        },
        baseContext,
      ),
    ).toEqual([])
  })

  it('processes Bulk events in order without letting duplicates leak sounds', () => {
    const resolver = createSoundEventResolver({
      [VOICE_OPEN_ID]: {
        [CURRENT_USER_ID]: voiceState(CURRENT_USER_ID),
        [REMOTE_USER_ID]: voiceState(REMOTE_USER_ID),
      },
    })

    expect(
      resolver.resolve(
        {
          type: 'Bulk',
          v: [
            {
              type: 'VoiceStateUpdate',
              channel_id: VOICE_OPEN_ID,
              state: { id: REMOTE_USER_ID, camera: true },
            },
            {
              type: 'VoiceStateUpdate',
              channel_id: VOICE_OPEN_ID,
              state: { id: REMOTE_USER_ID, camera: true },
            },
            {
              type: 'VoiceStateUpdate',
              channel_id: VOICE_OTHER_ID,
              state: { id: REMOTE_USER_ID, screensharing: true },
            },
          ],
        },
        baseContext,
      ),
    ).toEqual(['camera.started'])
  })

  it('processes Bulk voice channel membership in event order', () => {
    const resolver = createSoundEventResolver({
      [VOICE_OPEN_ID]: {
        [CURRENT_USER_ID]: voiceState(CURRENT_USER_ID),
        [REMOTE_USER_ID]: voiceState(REMOTE_USER_ID),
      },
    })

    expect(
      resolver.resolve(
        {
          type: 'Bulk',
          v: [
            {
              type: 'VoiceChannelLeave',
              id: VOICE_OPEN_ID,
              user: REMOTE_USER_ID,
            },
            {
              type: 'VoiceChannelMove',
              user: CURRENT_USER_ID,
              from: VOICE_OPEN_ID,
              to: VOICE_OTHER_ID,
              state: voiceState(CURRENT_USER_ID),
            },
            {
              type: 'VoiceChannelJoin',
              id: VOICE_OPEN_ID,
              state: voiceState(REMOTE_USER_ID),
            },
            {
              type: 'VoiceChannelJoin',
              id: VOICE_OTHER_ID,
              state: voiceState(REMOTE_USER_ID),
            },
          ],
        },
        { ...baseContext, currentVoiceChannelId: VOICE_OTHER_ID },
      ),
    ).toEqual(['voice.user_leave', 'voice.user_join'])
  })

  it('removes stale media state on leave before later snapshots arrive', () => {
    const resolver = createSoundEventResolver({
      [VOICE_OPEN_ID]: {
        [CURRENT_USER_ID]: voiceState(CURRENT_USER_ID),
        [REMOTE_USER_ID]: voiceState(REMOTE_USER_ID, { screensharing: true }),
      },
    })

    expect(
      resolver.resolve(
        {
          type: 'VoiceChannelLeave',
          id: VOICE_OPEN_ID,
          user: REMOTE_USER_ID,
        },
        baseContext,
      ),
    ).toEqual(['voice.user_leave'])

    expect(
      resolver.resolve(
        {
          type: 'VoiceStateUpdate',
          channel_id: VOICE_OPEN_ID,
          state: { id: REMOTE_USER_ID, screensharing: false },
        },
        baseContext,
      ),
    ).toEqual([])
  })
})
