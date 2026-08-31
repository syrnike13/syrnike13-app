import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  MEDIA_LIFECYCLE_MAX_REMOTE_VIDEO_DEMANDS,
  MEDIA_LIFECYCLE_MAX_REQUEST_ID_LENGTH,
  MEDIA_LIFECYCLE_PROTOCOL_VERSION,
  MEDIA_LIFECYCLE_SCHEMA_SHA256,
  EngineDesiredStateSchema,
  MediaCredentialLeaseSchema,
  MediaLifecycleDiagnosticMessageSchema,
  MediaLifecyclePublicEventMessageSchema,
  MediaLifecycleReplySchema,
  MediaLifecycleRequestSchema,
  RoomIntentSchema,
  isMediaLifecycleMessage,
  isMediaLifecycleRequest,
  mediaLifecycleFailure,
  type EngineDesiredState,
} from './contract'
import {
  MEDIA_LIFECYCLE_CANONICAL_FIXTURES,
  MEDIA_LIFECYCLE_EVENT_FIELDS,
  MEDIA_LIFECYCLE_PROTOCOL_COMMANDS,
  MEDIA_LIFECYCLE_PROTOCOL_FIELDS,
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS,
  MEDIA_LIFECYCLE_PROTOCOL_RESULTS,
  MEDIA_LIFECYCLE_PUBLIC_EVENTS,
  MEDIA_LIFECYCLE_ROOM_STATES,
} from './protocol.generated'

const off = { state: 'off' } as const

function desiredState(revision = 1): EngineDesiredState {
  return {
    revision,
    room: {
      roomId: 'room-1',
      participantIdentity: 'participant-1',
      credentialLeaseId: 'lease-1',
    },
    microphone: off,
    camera: off,
    screen: off,
    output: off,
    remoteVideoDemand: [],
  }
}

describe('native media protocol v3 contract', () => {
  it('validates the canonical source and generated C++ identity', () => {
    const sourceUrl = new URL(
      '../../../../../packages/windows-media-engine/protocol/media-lifecycle.json',
      import.meta.url,
    )
    const source = readFileSync(sourceUrl, 'utf8')
    const specification = JSON.parse(source) as {
      version: number
      limits: object
      commands: string[]
      results: string[]
      publicEvents: string[]
      eventFields: Record<string, { required: string[]; optional: string[] }>
      roomStates: string[]
      canonical: {
        credentialLease: unknown
        roomIntent: unknown
        desiredState: unknown
        requests: unknown[]
        successReplies: unknown[]
        failureReplies: unknown[]
        publicEventMessages: unknown[]
      }
      fields: {
        failure: string[]
        roomIntent: string[]
        engineDesiredState: string[]
      }
    }
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      MEDIA_LIFECYCLE_SCHEMA_SHA256,
    )
    expect(specification.version).toBe(MEDIA_LIFECYCLE_PROTOCOL_VERSION)
    expect(MEDIA_LIFECYCLE_PROTOCOL_LIMITS).toEqual(specification.limits)
    expect(MEDIA_LIFECYCLE_PROTOCOL_FIELDS).toEqual(specification.fields)
    expect(MEDIA_LIFECYCLE_EVENT_FIELDS).toEqual(specification.eventFields)
    expect(MEDIA_LIFECYCLE_PROTOCOL_COMMANDS).toEqual(specification.commands)
    expect(MEDIA_LIFECYCLE_PROTOCOL_RESULTS).toEqual(specification.results)
    expect(MEDIA_LIFECYCLE_PUBLIC_EVENTS).toEqual(specification.publicEvents)
    expect(MEDIA_LIFECYCLE_ROOM_STATES).toEqual(specification.roomStates)
    expect(Schema.is(MediaCredentialLeaseSchema)(
      specification.canonical.credentialLease,
    )).toBe(true)
    expect(Schema.is(RoomIntentSchema)(specification.canonical.roomIntent)).toBe(true)
    expect(Schema.is(EngineDesiredStateSchema)(
      specification.canonical.desiredState,
    )).toBe(true)
    expect(Object.keys(specification.canonical.roomIntent as object)).toEqual(
      specification.fields.roomIntent,
    )
    expect(Object.keys(specification.canonical.desiredState as object)).toEqual(
      specification.fields.engineDesiredState,
    )
    expect(MEDIA_LIFECYCLE_CANONICAL_FIXTURES).toEqual(specification.canonical)
    expect(specification.canonical.requests).toHaveLength(specification.commands.length)
    expect(specification.canonical.successReplies).toHaveLength(specification.results.length)
    expect(specification.canonical.publicEventMessages).toHaveLength(
      specification.publicEvents.length,
    )
    expect(specification.canonical.requests.map((request) =>
      (request as { command: { type: string } }).command.type,
    )).toEqual(specification.commands)
    expect(specification.canonical.successReplies.map((reply) =>
      (reply as { result: { type: string } }).result.type,
    )).toEqual(specification.results)
    expect(specification.canonical.publicEventMessages.map((message) =>
      (message as { event: { type: string } }).event.type,
    )).toEqual(specification.publicEvents)
    for (const request of specification.canonical.requests) {
      expect(Schema.is(MediaLifecycleRequestSchema)(request)).toBe(true)
    }
    for (const reply of [
      ...specification.canonical.successReplies,
      ...specification.canonical.failureReplies,
    ]) {
      expect(Schema.is(MediaLifecycleReplySchema)(reply)).toBe(true)
    }
    const snapshotReply = specification.canonical.successReplies.find((reply) =>
      (reply as { result?: { type?: string } }).result?.type === 'snapshot') as {
        result: { snapshot: { acceptedRevision: number | null; desiredState: unknown } }
      }
    expect(snapshotReply.result.snapshot.acceptedRevision).toBe(
      (snapshotReply.result.snapshot.desiredState as { revision: number }).revision,
    )
    for (const event of specification.canonical.publicEventMessages) {
      expect(Schema.is(MediaLifecyclePublicEventMessageSchema)(event)).toBe(true)
      const value = (event as { event: { type: string; failure?: object } }).event
      const fields = specification.eventFields[value.type]
      expect(fields).toBeDefined()
      expect(Object.keys(value)).toEqual([
        ...fields.required,
        ...fields.optional.filter((field) => Object.hasOwn(value, field)),
      ])
      if (value.failure) {
        expect(Object.keys(value.failure)).toEqual(specification.fields.failure)
      }
    }
    const nativeHeader = readFileSync(
      new URL(
        '../../../../../packages/windows-media-engine/native/src/core/protocol_limits.generated.hpp',
        import.meta.url,
      ),
      'utf8',
    )
    expect(nativeHeader).toContain(MEDIA_LIFECYCLE_SCHEMA_SHA256)
  })
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
              credentialLeaseId: 'lease-1',
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
              credentialLeaseId: 'lease-1',
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
