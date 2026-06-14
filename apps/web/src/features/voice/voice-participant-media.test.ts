import { describe, expect, it } from 'vitest'
import { Track } from 'livekit-client'

import {
  localParticipantVoiceFlags,
  participantHasCamera,
} from './voice-participant-media'

function participantWithPublications(publications: unknown[], isCameraEnabled = false) {
  return {
    isCameraEnabled,
    trackPublications: new Map(
      publications.map((publication, index) => [String(index), publication]),
    ),
  }
}

describe('voice participant media flags', () => {
  it('does not keep camera enabled from a stale local LiveKit flag', () => {
    const participant = participantWithPublications([], true)

    expect(participantHasCamera(participant as never)).toBe(false)
    expect(localParticipantVoiceFlags(participant as never).camera).toBe(false)
  })

  it('treats an active camera publication as camera enabled', () => {
    const participant = participantWithPublications([
      {
        kind: Track.Kind.Video,
        source: Track.Source.Camera,
        isMuted: false,
        track: {},
      },
    ])

    expect(participantHasCamera(participant as never)).toBe(true)
    expect(localParticipantVoiceFlags(participant as never).camera).toBe(true)
  })

  it('ignores audio publications with a camera source', () => {
    const participant = participantWithPublications([
      {
        kind: Track.Kind.Audio,
        source: Track.Source.Camera,
        isMuted: false,
        track: {},
      },
    ])

    expect(participantHasCamera(participant as never)).toBe(false)
    expect(localParticipantVoiceFlags(participant as never).camera).toBe(false)
  })

  it('treats a muted camera publication as camera disabled', () => {
    const participant = participantWithPublications([
      {
        kind: Track.Kind.Video,
        source: Track.Source.Camera,
        isMuted: true,
        track: {},
      },
    ], true)

    expect(participantHasCamera(participant as never)).toBe(false)
    expect(localParticipantVoiceFlags(participant as never).camera).toBe(false)
  })

  it('does not keep local camera enabled from a publication without a track', () => {
    const participant = participantWithPublications([
      {
        kind: Track.Kind.Video,
        source: Track.Source.Camera,
        isMuted: false,
        track: null,
      },
    ])

    expect(participantHasCamera(participant as never)).toBe(true)
    expect(localParticipantVoiceFlags(participant as never).camera).toBe(false)
  })
})
