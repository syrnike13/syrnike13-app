import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  MEDIA_LIFECYCLE_MAX_REMOTE_VIDEO_DEMANDS,
  MEDIA_LIFECYCLE_MAX_REQUEST_ID_LENGTH,
  MEDIA_LIFECYCLE_PROTOCOL_VERSION,
  EngineDesiredStateSchema,
  MediaLifecycleDiagnosticMessageSchema,
  MediaLifecycleRequestSchema,
  isMediaLifecycleMessage,
  isMediaLifecycleRequest,
  mediaLifecycleFailure,
  type EngineDesiredState,
} from './contract'

const off = { state: 'off' } as const

function desiredState(revision = 1): EngineDesiredState {
  return {
    revision,
    room: {
      roomId: 'room-1',
      participantIdentity: 'participant-1',
    },
    microphone: off,
    camera: off,
    screen: off,
    output: off,
    remoteVideoDemand: [],
  }
}

describe('native media protocol v2 contract', () => {
  it('accepts the maximum valid request and rejects one byte or entry over', () => {
    const maximum = {
      type: 'request',
      protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
      requestId: 'r'.repeat(MEDIA_LIFECYCLE_MAX_REQUEST_ID_LENGTH),
      hostEpoch: 1,
      deadlineMs: 5_000,
      command: {
        type: 'applyDesiredState',
        desiredState: {
          ...desiredState(),
          remoteVideoDemand: Array.from(
            { length: MEDIA_LIFECYCLE_MAX_REMOTE_VIDEO_DEMANDS },
            (_, index) => ({
              participantIdentity: `participant-${index}`,
              publicationId: `publication-${index}`,
              quality: 'off' as const,
            }),
          ),
        },
      },
    }
    expect(isMediaLifecycleRequest(maximum)).toBe(true)
    expect(
      isMediaLifecycleRequest({
        ...maximum,
        command: {
          ...maximum.command,
          desiredState: {
            ...maximum.command.desiredState,
            room: {
              roomId: 'x'.repeat(256),
              participantIdentity: 'participant',
            },
          },
        },
      }),
    ).toBe(true)
    expect(
      isMediaLifecycleRequest({
        ...maximum,
        command: {
          ...maximum.command,
          desiredState: {
            ...maximum.command.desiredState,
            room: {
              roomId: 'x'.repeat(257),
              participantIdentity: 'participant',
            },
          },
        },
      }),
    ).toBe(false)
    expect(
      isMediaLifecycleRequest({
        ...maximum,
        requestId: `${maximum.requestId}x`,
      }),
    ).toBe(false)
    expect(
      isMediaLifecycleRequest({
        ...maximum,
        command: {
          ...maximum.command,
          desiredState: {
            ...maximum.command.desiredState,
            remoteVideoDemand: [
              ...maximum.command.desiredState.remoteVideoDemand,
              {
                participantIdentity: 'one-too-many',
                publicationId: 'one-too-many',
                quality: 'off',
              },
            ],
          },
        },
      }),
    ).toBe(false)
  })

  it('rejects malformed, partial, and incompatible commands', () => {
    const base = {
      type: 'request',
      protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
      requestId: 'apply-1',
      hostEpoch: 1,
      deadlineMs: 1_000,
      command: { type: 'applyDesiredState', desiredState: desiredState() },
    }
    expect(isMediaLifecycleRequest(base)).toBe(true)
    expect(isMediaLifecycleRequest({ ...base, protocolVersion: 1 })).toBe(false)
    expect(
      isMediaLifecycleRequest({
        ...base,
        command: {
          ...base.command,
          desiredState: { ...desiredState(), camera: { state: 'on' } },
        },
      }),
    ).toBe(false)
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(EngineDesiredStateSchema)({
          revision: 2,
          microphone: off,
        }),
      ),
    ).toBe(true)
    expect(
      isMediaLifecycleRequest({
        ...base,
        unexpected: { nested: { payload: 'must not cross the boundary' } },
      }),
    ).toBe(false)
  })

  it('rejects a deterministic malformed matrix without throwing', () => {
    const malformedRevisions = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      0,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]
    for (let index = 0; index < 512; index += 1) {
      const candidate = {
        type: 'request',
        protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
        requestId: `fuzz-${index}`,
        hostEpoch: 1,
        deadlineMs: 1_000,
        command: {
          type: 'applyDesiredState',
          desiredState: desiredState(
            malformedRevisions[index % malformedRevisions.length],
          ),
        },
      }
      expect(() => isMediaLifecycleRequest(candidate)).not.toThrow()
      expect(isMediaLifecycleRequest(candidate)).toBe(false)
    }
  })

  it('keeps public and diagnostic events as separate message variants', () => {
    const diagnostic = {
      type: 'diagnostic',
      protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
      event: {
        sequence: 1,
        timestampMs: 10,
        component: 'engine',
        operation: 'apply_desired_state',
        code: 'desired_state_accepted',
        metrics: [{ name: 'revision', value: 2 }],
        implementation: [{ name: 'backend', value: 'none' }],
      },
    }
    expect(Schema.is(MediaLifecycleDiagnosticMessageSchema)(diagnostic)).toBe(true)
    expect(isMediaLifecycleMessage(diagnostic)).toBe(true)
    expect(
      Schema.is(MediaLifecycleDiagnosticMessageSchema)({
        type: 'event',
        protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
        event: {
          type: 'fatalEngineFailure',
          sequence: 1,
          failure: {
            code: 'fatal',
            message: 'fatal',
            stage: 'engine',
            retryable: false,
          },
        },
      }),
    ).toBe(false)
  })

  it('always produces a non-empty bounded redacted failure message', () => {
    expect(mediaLifecycleFailure('failure', '', 'test').message).toBe('unknown')
    expect(
      mediaLifecycleFailure(
        'failure',
        'authorization=secret https://example.invalid/private',
        'test',
      ).message,
    ).toBe('authorization=[redacted] [redacted-url]')
  })
})
