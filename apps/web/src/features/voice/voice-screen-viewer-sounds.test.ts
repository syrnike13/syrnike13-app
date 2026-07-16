import { describe, expect, it } from 'vitest'

import {
  SCREEN_VIEWER_SOUND_TOPIC,
  createScreenViewerSoundPayload,
  screenViewerWatchNotification,
  screenViewerSoundEventFromData,
} from './voice-screen-viewer-sounds'

const viewerIdentity = 'viewer-1'
const ownerUserId = 'owner-1'

describe('screen viewer sound data messages', () => {
  it('maps a viewer join message addressed to the local screen owner', () => {
    const payload = createScreenViewerSoundPayload({
      action: 'join',
      screenOwnerId: ownerUserId,
    })

    expect(
      screenViewerSoundEventFromData({
        payload,
        topic: SCREEN_VIEWER_SOUND_TOPIC,
        senderIdentity: viewerIdentity,
        currentUserId: ownerUserId,
      }),
    ).toBe('screen_share.viewer_join')
  })

  it('maps a viewer leave message addressed to the local screen owner', () => {
    const payload = createScreenViewerSoundPayload({
      action: 'leave',
      screenOwnerId: ownerUserId,
    })

    expect(
      screenViewerSoundEventFromData({
        payload,
        topic: SCREEN_VIEWER_SOUND_TOPIC,
        senderIdentity: viewerIdentity,
        currentUserId: ownerUserId,
      }),
    ).toBe('screen_share.viewer_leave')
  })

  it('ignores malformed, self, wrong-topic, and wrong-owner messages', () => {
    const payload = createScreenViewerSoundPayload({
      action: 'join',
      screenOwnerId: ownerUserId,
    })

    expect(
      screenViewerSoundEventFromData({
        payload,
        topic: 'other-topic',
        senderIdentity: viewerIdentity,
        currentUserId: ownerUserId,
      }),
    ).toBeNull()
    expect(
      screenViewerSoundEventFromData({
        payload,
        topic: SCREEN_VIEWER_SOUND_TOPIC,
        senderIdentity: ownerUserId,
        currentUserId: ownerUserId,
      }),
    ).toBeNull()
    expect(
      screenViewerSoundEventFromData({
        payload,
        topic: SCREEN_VIEWER_SOUND_TOPIC,
        senderIdentity: viewerIdentity,
        currentUserId: 'owner-2',
      }),
    ).toBeNull()
    expect(
      screenViewerSoundEventFromData({
        payload: new TextEncoder().encode('{'),
        topic: SCREEN_VIEWER_SOUND_TOPIC,
        senderIdentity: viewerIdentity,
        currentUserId: ownerUserId,
      }),
    ).toBeNull()
  })
})

describe('screen viewer watch notifications', () => {
  it('notifies only when a remote watch state actually changes', () => {
    expect(
      screenViewerWatchNotification({
        isLocal: false,
        wasWatching: false,
        subscribed: true,
      }),
    ).toBe('join')
    expect(
      screenViewerWatchNotification({
        isLocal: false,
        wasWatching: true,
        subscribed: false,
      }),
    ).toBe('leave')
    expect(
      screenViewerWatchNotification({
        isLocal: false,
        wasWatching: true,
        subscribed: true,
      }),
    ).toBeNull()
    expect(
      screenViewerWatchNotification({
        isLocal: true,
        wasWatching: false,
        subscribed: true,
      }),
    ).toBeNull()
  })
})
