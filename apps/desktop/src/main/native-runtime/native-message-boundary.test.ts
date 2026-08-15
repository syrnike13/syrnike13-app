import { createRequire } from 'node:module'
import path from 'node:path'

import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  NativeRuntimeCommandSchema,
  NativeRuntimeEventSchema,
  NativeRuntimeReplySchema,
} from './contract'
import { schemaWitnesses } from './native-message-contract-generator'

const ContractRowSchema = Schema.Struct({
  direction: Schema.Literals(['command', 'event']),
  wireName: Schema.String,
  shape: Schema.String,
  lane: Schema.optional(Schema.String),
})

const ContractRowsSchema = Schema.Array(ContractRowSchema)

interface NativeMessageContractAddon {
  readonly contracts: () => unknown
  readonly parseCommand: (command: unknown) => unknown
  readonly serializeEvents: () => unknown
  readonly serializeReplyVariants: () => unknown
  readonly validateEvent: (event: unknown) => unknown
}

function commandEnvelope(command: object, lane: string): object {
  let requestId = 'envelope-request-contract'
  if ('options' in command && command.options !== null &&
      typeof command.options === 'object' &&
      'requestId' in command.options &&
      typeof command.options.requestId === 'string') {
    requestId = command.options.requestId
  }
  return {
    ...command,
    requestId,
    lane,
    hostEpoch: 23,
    diagnostic: {
      actionId: 'action-contract',
      operationId: 'operation-contract',
      hostEpoch: 23,
      revision: 29,
    },
  }
}

const addonPath = process.env.SYRNIKE_NATIVE_MESSAGE_CONTRACT_ADDON

function boundaryHarness() {
  if (addonPath === undefined) {
    throw new Error('native message contract addon path is required')
  }
  const addon: NativeMessageContractAddon = createRequire(import.meta.url)(
    path.resolve(addonPath),
  )
  const contracts = Schema.decodeUnknownSync(ContractRowsSchema)(
    addon.contracts(),
  )
  const commandContracts = new Map(contracts
    .filter(({ direction }) => direction === 'command')
    .map((row) => [row.wireName, row]))
  const eventContracts = contracts.filter(({ direction }) => direction === 'event')
  return { addon, commandContracts, eventContracts }
}

describe.runIf(addonPath !== undefined)('native message actual boundary corpus', () => {
  it('round-trips every recursively populated command witness through parsing', () => {
    const { addon, commandContracts } = boundaryHarness()
    const commands = schemaWitnesses(NativeRuntimeCommandSchema.ast)
      .map((witness) => Schema.decodeUnknownSync(NativeRuntimeCommandSchema)(witness))
    expect(new Set(commands.map(({ type }) => type))).toEqual(
      new Set(commandContracts.keys()),
    )
    for (const command of commands) {
      const contract = commandContracts.get(command.type)
      expect(contract).toBeDefined()
      const parsed = addon.parseCommand(commandEnvelope(
        command,
        contract?.lane ?? 'missing-lane',
      ))
      expect(parsed).toMatchObject(command)
    }
  })

  it('decodes every production-serialized external event with Effect Schema', () => {
    const { addon, eventContracts } = boundaryHarness()
    const serialized = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
      addon.serializeEvents(),
    )
    expect(serialized.length).toBe(eventContracts.length)
    const decodedEvents = serialized.map((event, index) => {
      const contract = eventContracts[index]
      expect(contract).toBeDefined()
      const decoded = contract?.wireName === 'reply'
        ? Schema.decodeUnknownSync(NativeRuntimeReplySchema)(event)
        : Schema.decodeUnknownSync(NativeRuntimeEventSchema)(event)
      expect(decoded.type).toBe(contract?.wireName)
      return decoded
    })
    const voiceStats = decodedEvents.find(({ type }) => type === 'voiceStats')
    if (voiceStats?.type !== 'voiceStats') {
      throw new Error('voiceStats production witness is absent')
    }
    expect(voiceStats.stats.transport).toMatchObject({
      localAddress: '127.0.0.1:4001',
      selectedCandidatePairId: 'candidate-pair-event',
    })
    expect(voiceStats.stats.outbound.map(({ kind }) => kind)).toEqual(['video'])
    expect(voiceStats.stats.inbound.map(({ kind }) => kind)).toEqual([
      'video',
      'audio',
    ])
    expect(voiceStats.stats.outbound[0]).toMatchObject({
      encoderImplementation: 'encoder-voice-event',
      frameWidth: 1280,
    })
    expect(voiceStats.stats.inbound).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'video',
        decoderImplementation: 'decoder-video-event',
      }),
      expect.objectContaining({
        kind: 'audio',
        concealmentEvents: 661,
      }),
    ]))

    const replyVariants = Schema.decodeUnknownSync(
      Schema.Array(NativeRuntimeReplySchema),
    )(addon.serializeReplyVariants())
    expect(replyVariants.map(({ ok }) => ok)).toEqual([false, true])
  })

  it('rejects omit, rename, type, optionality, and nested-union mutations', () => {
    const { addon, commandContracts } = boundaryHarness()
    const commands = schemaWitnesses(NativeRuntimeCommandSchema.ast)
      .map((witness) => Schema.decodeUnknownSync(NativeRuntimeCommandSchema)(witness))
    const release = commands.find((command) =>
      command.type === 'releaseRemoteVideoFrame')
    const warm = commands.find((command) => command.type === 'warmMicrophone')
    const connect = commands.find((command) => command.type === 'connectMicrophone')
    if (release?.type !== 'releaseRemoteVideoFrame' ||
        warm?.type !== 'warmMicrophone' ||
        connect?.type !== 'connectMicrophone') {
      throw new Error('required mutation witnesses are absent')
    }
    const releaseContract = commandContracts.get(release.type)
    const warmContract = commandContracts.get(warm.type)
    const connectContract = commandContracts.get(connect.type)
    if (!releaseContract?.lane || !warmContract?.lane || !connectContract?.lane) {
      throw new Error('required mutation policies are absent')
    }

    const { sequence: _omittedSequence, ...withoutSequence } = release
    expect(() => addon.parseCommand(commandEnvelope(
      withoutSequence, releaseContract.lane,
    ))).toThrow()
    expect(() => addon.parseCommand(commandEnvelope(
      { ...release, sequence: 'wrong-type' }, releaseContract.lane,
    ))).toThrow()

    const { deviceId: renamedDeviceId, ...warmConfigWithoutDevice } = warm.config
    expect(() => addon.parseCommand(commandEnvelope({
      ...warm,
      config: { ...warmConfigWithoutDevice, renamedDeviceId },
    }, warmContract.lane))).toThrow()
    expect(() => addon.parseCommand(commandEnvelope({
      ...warm,
      config: { ...warm.config, deviceId: { wrong: 'union-member' } },
    }, warmContract.lane))).toThrow()

    expect(() => addon.parseCommand(commandEnvelope({
      ...connect,
      options: { ...connect.options, audioBitrate: undefined },
    }, connectContract.lane))).not.toThrow()
    expect(() => addon.parseCommand(commandEnvelope({
      ...connect,
      options: { ...connect.options, audioBitrate: null },
    }, connectContract.lane))).toThrow()

    const events = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
      addon.serializeEvents(),
    )
    const decodedEvents = events.map((event) =>
      Schema.decodeUnknownSync(
        Schema.Union([NativeRuntimeEventSchema, NativeRuntimeReplySchema]),
      )(event))
    const voiceStats = decodedEvents.find(({ type }) => type === 'voiceStats')
    if (voiceStats?.type !== 'voiceStats' ||
        voiceStats.stats.outbound[0] === undefined) {
      throw new Error('nested voice stream mutation witness is absent')
    }
    const [outbound, ...remainingOutbound] = voiceStats.stats.outbound
    const { pcRole: _omittedPcRole, ...withoutPcRole } = outbound
    const omittedNestedField = {
      ...voiceStats,
      stats: {
        ...voiceStats.stats,
        outbound: [withoutPcRole, ...remainingOutbound],
      },
    }
    expect(() => addon.validateEvent(omittedNestedField)).toThrow()
    expect(() => Schema.decodeUnknownSync(NativeRuntimeEventSchema)(
      omittedNestedField,
    )).toThrow()

    const wrongNestedUnion = {
      ...voiceStats,
      stats: {
        ...voiceStats.stats,
        outbound: [{ ...outbound, kind: 'data' }, ...remainingOutbound],
      },
    }
    expect(() => addon.validateEvent(wrongNestedUnion)).toThrow()
    expect(() => Schema.decodeUnknownSync(NativeRuntimeEventSchema)(
      wrongNestedUnion,
    )).toThrow()
  })
})
