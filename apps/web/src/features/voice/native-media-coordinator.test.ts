import { describe, expect, it } from 'vitest'

import {
  createInitialNativeMediaState,
  nativeMediaReducer,
} from './native-media-coordinator'

describe('native media coordinator', () => {
  it('keeps screen starting until publication is observed', () => {
    const initial = createInitialNativeMediaState()
    const starting = nativeMediaReducer(initial, {
      type: 'screen_start_requested',
      operationId: 'op-1',
      channelId: 'channel-1',
      requestId: 'request-1',
    })

    expect(starting.screen).toMatchObject({
      status: 'starting',
      operationId: 'op-1',
      channelId: 'channel-1',
      requestId: 'request-1',
      visibleInRoom: false,
    })
  })

  it('marks screen published only after current publication is observed', () => {
    const starting = nativeMediaReducer(createInitialNativeMediaState(), {
      type: 'screen_start_requested',
      operationId: 'op-1',
      channelId: 'channel-1',
      requestId: 'request-1',
    })

    const published = nativeMediaReducer(starting, {
      type: 'screen_publication_observed',
      operationId: 'op-1',
      channelId: 'channel-1',
      participantIdentity: 'user-1:desktop-native:screen',
      publicationSid: 'screen-publication-1',
    })

    expect(published.screen).toMatchObject({
      status: 'published',
      operationId: 'op-1',
      channelId: 'channel-1',
      participantIdentity: 'user-1:desktop-native:screen',
      publicationSid: 'screen-publication-1',
      visibleInRoom: true,
    })
  })

  it('ignores stale screen publication observations', () => {
    const starting = nativeMediaReducer(createInitialNativeMediaState(), {
      type: 'screen_start_requested',
      operationId: 'op-2',
      channelId: 'channel-2',
      requestId: 'request-2',
    })

    const unchanged = nativeMediaReducer(starting, {
      type: 'screen_publication_observed',
      operationId: 'op-1',
      channelId: 'channel-1',
      participantIdentity: 'user-1:desktop-native:screen',
      publicationSid: 'stale-publication',
    })

    expect(unchanged).toBe(starting)
  })

  it('clears native screen state on operation reset', () => {
    const starting = nativeMediaReducer(createInitialNativeMediaState(), {
      type: 'screen_start_requested',
      operationId: 'op-1',
      channelId: 'channel-1',
      requestId: 'request-1',
    })

    expect(nativeMediaReducer(starting, { type: 'reset' })).toEqual(
      createInitialNativeMediaState(),
    )
  })
})
