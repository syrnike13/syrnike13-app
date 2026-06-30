/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_STAGE_MEDIA_FILTERS,
  readStageMediaFilters,
  writeStageMediaFilters,
} from '#/features/voice/voice-stage-filters'

describe('voice stage filters', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('returns defaults when storage is empty', () => {
    expect(readStageMediaFilters()).toEqual(DEFAULT_STAGE_MEDIA_FILTERS)
  })

  it('merges stored partial filters with defaults', () => {
    window.localStorage.setItem(
      'syrnike13.voice.stageMediaFilters',
      JSON.stringify({ showRemoteStreams: false }),
    )

    expect(readStageMediaFilters()).toEqual({
      showOwnStream: true,
      showRemoteStreams: false,
      showParticipantsWithoutMedia: true,
    })
  })

  it('writes filters to storage', () => {
    writeStageMediaFilters({
      showOwnStream: false,
      showRemoteStreams: true,
      showParticipantsWithoutMedia: false,
    })

    expect(
      JSON.parse(
        window.localStorage.getItem('syrnike13.voice.stageMediaFilters') ?? '',
      ),
    ).toEqual({
      showOwnStream: false,
      showRemoteStreams: true,
      showParticipantsWithoutMedia: false,
    })
  })
})
