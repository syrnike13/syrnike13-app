import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { Schema, SchemaAST } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  NativeRuntimeCommandSchema,
  NativeRuntimeEventSchema,
  NativeRuntimeReplySchema,
} from './contract'
import {
  fieldContractViolations,
  mergeFieldContracts,
  renderNativeFieldShapeCatalog,
  schemaFieldContracts,
  schemaWitnesses,
} from './native-message-contract-generator'

type Visibility = 'External' | 'Internal' | 'TestOnly'

interface NativePolicyRow {
  readonly nativeName: string
  readonly wireName: string
  readonly visibility: Visibility
  readonly destination: string
  readonly lane: string
  readonly owner: string
  readonly loss: string
  readonly delivery: string
  readonly drop: string
  readonly payload: string
  readonly schema: string
  readonly action: string
}

const policyRow = /\bX\(([^,]+),\s*"([^"]+)",\s*(External|Internal|TestOnly),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,)]+)\)/g

function rows(section: string): NativePolicyRow[] {
  const normalized = section.replace(/\\\r?\n/g, ' ')
  return [...normalized.matchAll(policyRow)].map((match) => ({
    nativeName: match[1]!.trim(),
    wireName: match[2]!,
    visibility: match[3]! as Visibility,
    destination: match[4]!.trim(),
    lane: match[5]!.trim(),
    owner: match[6]!.trim(),
    loss: match[7]!.trim(),
    delivery: match[8]!.trim(),
    drop: match[9]!.trim(),
    payload: match[10]!.trim(),
    schema: match[11]!.trim(),
    action: match[12]!.trim(),
  }))
}

function schemaWireContracts(ast: SchemaAST.AST): Map<string, Set<string>> {
  const contracts = new Map<string, Set<string>>()
  const visit = (current: SchemaAST.AST, inherited?: string): void => {
    const identifier = SchemaAST.resolveIdentifier(current) ?? inherited
    if (identifier !== undefined && SchemaAST.isObjects(current)) {
      const discriminant = current.propertySignatures.find(
        ({ name }) => name === 'type',
      )?.type
      if (discriminant !== undefined && SchemaAST.isLiteral(discriminant) &&
          typeof discriminant.literal === 'string') {
        const wireNames = contracts.get(identifier) ?? new Set<string>()
        wireNames.add(discriminant.literal)
        contracts.set(identifier, wireNames)
      }
    }
    if (SchemaAST.isUnion(current)) {
      for (const member of current.types) visit(member, identifier)
    }
  }
  visit(ast)
  return contracts
}

function catalogViolations(
  commandRows: readonly NativePolicyRow[],
  eventRows: readonly NativePolicyRow[],
): string[] {
  const violations: string[] = []
  const allRows = [...commandRows, ...eventRows]
  const schemas = allRows.map(({ schema }) => schema)
  const actions = allRows.map(({ action }) => action)
  if (new Set(schemas).size !== schemas.length) violations.push('duplicate schema')
  if (new Set(actions).size !== actions.length) violations.push('duplicate action')
  for (const row of allRows.filter(({ payload }) => payload === 'VideoFrame')) {
    const ownsFrame = row.wireName.startsWith('__') ||
      (row.wireName.endsWith('Frame') && !row.wireName.startsWith('release'))
    if (!ownsFrame) continue
    if (row.lane !== 'Media' || row.owner !== 'RendererLease' ||
        row.loss !== 'CoalescedLatest' || row.drop !== 'RequiredExactOnce') {
      violations.push(`resource policy: ${row.nativeName}`)
    }
  }
  return violations
}

async function nativeSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return nativeSourceFiles(target)
    return entry.isFile() && /\.(?:cpp|hpp)$/.test(entry.name) ? [target] : []
  }))
  return files.flat()
}

describe('native message policy contract', () => {
  it('keeps internal native message tags enum-only', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../../..')
    const sourceRoot = path.join(
      repositoryRoot,
      'packages/desktop-native/native/src',
    )
    const violations: string[] = []
    for (const file of await nativeSourceFiles(sourceRoot)) {
      const source = await readFile(file, 'utf8')
      const relative = path.relative(repositoryRoot, file)
      for (const match of source.matchAll(
        /(?:\.|->)type\s*(?:==|!=|=)\s*"[^"]+"/g,
      )) {
        const line = source.slice(0, match.index).split(/\r?\n/).length
        violations.push(`${relative}:${line}: ${match[0]}`)
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps every external native type represented by the versioned Electron schema', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../../..')
    const [nativePolicy, contract, nativeContractVersion] = await Promise.all([
      readFile(path.join(
        repositoryRoot,
        'packages/desktop-native/native/src/common/native_message_policy.hpp',
      ), 'utf8'),
      readFile(path.join(
        repositoryRoot,
        'apps/desktop/src/main/native-runtime/contract.ts',
      ), 'utf8'),
      readFile(path.join(
        repositoryRoot,
        'packages/desktop-native/native/src/common/native_contract_version.hpp',
      ), 'utf8'),
    ])
    const commandStart = nativePolicy.indexOf('#define SYRNIKE_NATIVE_COMMAND_POLICY')
    const eventStart = nativePolicy.indexOf('#define SYRNIKE_NATIVE_EVENT_POLICY')
    const commandRows = rows(nativePolicy.slice(commandStart, eventStart))
    const eventRows = rows(nativePolicy.slice(eventStart))
    const commandFieldContracts = schemaWireContracts(
      NativeRuntimeCommandSchema.ast,
    )
    const eventFieldContracts = schemaWireContracts(NativeRuntimeEventSchema.ast)
    for (const [identifier, wireNames] of schemaWireContracts(
      NativeRuntimeReplySchema.ast,
    )) {
      eventFieldContracts.set(identifier, wireNames)
    }

    expect(commandRows.length).toBeGreaterThan(50)
    expect(eventRows.length).toBeGreaterThan(25)
    expect(contract).toMatch(/NATIVE_RUNTIME_CONTRACT_VERSION\s*=\s*10\b/)
    expect(nativeContractVersion).toMatch(/kNativeRuntimeContractVersion\s*=\s*10\b/)
    expect(commandRows.filter(({ schema, action }) =>
      schema === 'None' || action === 'None'))
      .toEqual([])
    expect(eventRows.filter(({ schema, action }) =>
      schema === 'None' || action === 'None'))
      .toEqual([])
    expect(catalogViolations(commandRows, eventRows)).toEqual([])
    const allSchemas = [...commandRows, ...eventRows].map(({ schema }) => schema)
    const allActions = [...commandRows, ...eventRows].map(({ action }) => action)
    expect(new Set(allSchemas).size).toBe(allSchemas.length)
    expect(new Set(allActions).size).toBe(allActions.length)
    expect(commandRows
      .filter(({ visibility }) => visibility === 'External')
      .filter(({ schema, wireName }) =>
        !commandFieldContracts.get(schema)?.has(wireName))
      .map(({ schema, wireName }) => ({ schema, wireName })))
      .toEqual([])
    expect(eventRows
      .filter(({ visibility }) => visibility === 'External')
      .filter(({ schema, wireName }) =>
        !eventFieldContracts.get(schema)?.has(wireName))
      .map(({ schema, wireName }) => ({ schema, wireName })))
      .toEqual([])
  })

  it('generates every external native field shape from the Effect Schema AST', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../../..')
    const [nativePolicy, nativeBindings] = await Promise.all([
      readFile(path.join(
        repositoryRoot,
        'packages/desktop-native/native/src/common/native_message_policy.hpp',
      ), 'utf8'),
      readFile(path.join(
        repositoryRoot,
        'packages/desktop-native/native/src/common/native_message_bindings.hpp',
      ), 'utf8'),
    ])
    const commandStart = nativePolicy.indexOf('#define SYRNIKE_NATIVE_COMMAND_POLICY')
    const eventStart = nativePolicy.indexOf('#define SYRNIKE_NATIVE_EVENT_POLICY')
    const commandRows = rows(nativePolicy.slice(commandStart, eventStart))
    const eventRows = rows(nativePolicy.slice(eventStart))
    const externalSchemas = [...commandRows, ...eventRows]
      .filter(({ visibility }) => visibility === 'External')
      .map(({ schema }) => schema)
    const contracts = mergeFieldContracts(
      schemaFieldContracts(NativeRuntimeCommandSchema.ast),
      schemaFieldContracts(NativeRuntimeEventSchema.ast),
      schemaFieldContracts(NativeRuntimeReplySchema.ast),
    )
    const expected = renderNativeFieldShapeCatalog(externalSchemas, contracts)
    const generatedBlock = nativeBindings.match(
      /\/\/ BEGIN GENERATED EXTERNAL MESSAGE FIELD SHAPES[\s\S]*?\/\/ END GENERATED EXTERNAL MESSAGE FIELD SHAPES/,
    )?.[0]

    expect(generatedBlock).toBe(expected)

    for (const { schema, field } of [
      { schema: 'CommandReleaseRemoteVideoFrame', field: 'sequence' },
      { schema: 'EventRemoteVideoFrame', field: 'trackId' },
      { schema: 'CommandWarmMicrophone', field: 'deviceId' },
    ]) {
      const mutated = mergeFieldContracts(contracts)
      const variants = mutated.get(schema)
      expect(variants).toBeDefined()
      mutated.set(schema, new Set([...variants ?? []].map((variant) =>
        variant.split(',').filter((token) => !token.startsWith(field)).join(','),
      )))
      expect(fieldContractViolations(contracts, mutated)).toContain(
        `field shape: ${schema}`,
      )
    }

    const mutationCases = [
      ['CommandConnectMicrophone', 'audioBitrate?:', 'audioBitrate:'],
      ['CommandWarmMicrophone', 'deviceId:null|string', 'deviceId:string'],
      ['CommandWarmMicrophone', 'deviceId:null|string', 'renamedDeviceId:null|string'],
    ] as const
    for (const [schema, before, after] of mutationCases) {
      const mutated = mergeFieldContracts(contracts)
      const variants = mutated.get(schema)
      expect(variants).toBeDefined()
      mutated.set(schema, new Set([...variants ?? []].map((variant) =>
        variant.replace(before, after),
      )))
      expect(fieldContractViolations(contracts, mutated)).toContain(
        `field shape: ${schema}`,
      )
    }
  })

  it('generates recursively populated witnesses accepted by Effect', () => {
    const commandWitnesses = schemaWitnesses(NativeRuntimeCommandSchema.ast)
    const eventWitnesses = schemaWitnesses(NativeRuntimeEventSchema.ast)
    expect(commandWitnesses.length).toBeGreaterThan(30)
    expect(eventWitnesses.length).toBeGreaterThan(25)
    for (const value of commandWitnesses) {
      expect(() => Schema.decodeUnknownSync(NativeRuntimeCommandSchema)(value))
        .not.toThrow()
    }
    for (const value of eventWitnesses) {
      expect(() => Schema.decodeUnknownSync(NativeRuntimeEventSchema)(value))
        .not.toThrow()
    }
    expect(commandWitnesses).toContainEqual(expect.objectContaining({
      config: expect.objectContaining({ deviceId: expect.any(String) }),
    }))
  })

  it('keeps recursive event validation out of the production media path', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../../..')
    const [eventSink, bindings] = await Promise.all([
      readFile(path.join(
        repositoryRoot,
        'packages/desktop-native/native/src/common/node_event_sink.cpp',
      ), 'utf8'),
      readFile(path.join(
        repositoryRoot,
        'packages/desktop-native/native/src/common/native_message_bindings.hpp',
      ), 'utf8'),
    ])
    expect(eventSink).toContain('nativeExternalHasTopLevelField(')
    expect(eventSink).toMatch(
      /#if defined\(SYRNIKE_NATIVE_CONTRACT_RUNTIME_VALIDATION\)\s+requireNativeContractShape/g,
    )
    expect(bindings).toContain('inline constexpr auto kNativeExternalTopLevelMasks')
    expect(bindings).toContain('constexpr std::uint16_t nativeExternalTopLevelMask')
  })

  it('makes every resource-bearing message exact-once and renderer-owned', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../../..')
    const nativePolicy = await readFile(path.join(
      repositoryRoot,
      'packages/desktop-native/native/src/common/native_message_policy.hpp',
    ), 'utf8')
    const resourceRows = rows(nativePolicy)
      .filter(({ payload }) => payload === 'VideoFrame')
      .filter(({ wireName }) =>
        wireName.startsWith('__') ||
        (wireName.endsWith('Frame') && !wireName.startsWith('release')),
      )

    expect(resourceRows.length).toBeGreaterThanOrEqual(6)
    for (const row of resourceRows) {
      expect(row).toMatchObject({
        lane: 'Media',
        owner: 'RendererLease',
        loss: 'CoalescedLatest',
        drop: 'RequiredExactOnce',
      })
    }
  })

  it('keeps every actor terminal on accepted exact-once control delivery', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../../..')
    const nativePolicy = await readFile(path.join(
      repositoryRoot,
      'packages/desktop-native/native/src/common/native_message_policy.hpp',
    ), 'utf8')
    const terminals = rows(nativePolicy).filter(({ wireName }) =>
      wireName.startsWith('__') && wireName.endsWith('Terminal'),
    )

    expect(terminals.map(({ wireName }) => wireName).sort()).toEqual([
      '__cameraTerminal',
      '__microphoneTerminal',
      '__screenAudioTerminal',
      '__screenTerminal',
      '__voiceTerminal',
    ])
    for (const terminal of terminals) {
      expect(terminal).toMatchObject({
        lane: 'Control',
        loss: 'Lossless',
        delivery: 'AcceptedExactOnce',
      })
    }
  })
})
