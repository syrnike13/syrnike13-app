import { SchemaAST } from 'effect'

export type SchemaFieldContracts = ReadonlyMap<string, ReadonlySet<string>>

function witnessString(path: readonly string[]): string {
  const field = path.at(-1)
  if (field === 'code' && path.includes('localScreenPreviewFailed')) {
    return 'LOCAL_SCREEN_PREVIEW_FAILED'
  }
  if (field === 'code' && path.includes('localCameraPreviewFailed')) {
    return 'LOCAL_CAMERA_PREVIEW_FAILED'
  }
  if (field === 'url') return 'wss://contract.example.test'
  if (field === 'selfWindowHwnd') return '4096'
  return `${field ?? 'value'}-contract`
}

function witnessNumber(path: readonly string[]): number {
  const field = path.at(-1)
  if (path.some((segment) => segment.endsWith('Volumes'))) return 0.75
  if (field === 'width') return 640
  if (field === 'height') return 480
  if (field === 'fps') return 30
  if (field === 'bitrate') return 100_000
  if (field === 'audioBitrate') return 64_000
  if (field === 'inputVolume' || field === 'volume') return 0.75
  if (field === 'voiceGateThresholdDb') return -32
  return 17
}

function astWitness(
  ast: SchemaAST.AST,
  path: readonly string[],
  ancestors: ReadonlySet<SchemaAST.AST>,
): unknown {
  if (SchemaAST.isLiteral(ast)) return ast.literal
  if (SchemaAST.isString(ast) || SchemaAST.isTemplateLiteral(ast)) {
    return witnessString(path)
  }
  if (SchemaAST.isNumber(ast)) return witnessNumber(path)
  if (SchemaAST.isBoolean(ast)) return true
  if (SchemaAST.isBigInt(ast)) return 19n
  if (SchemaAST.isNull(ast)) return null
  if (SchemaAST.isUndefined(ast)) return undefined
  if (SchemaAST.isUnknown(ast) || SchemaAST.isAny(ast) || SchemaAST.isEnum(ast)) {
    return 'unknown-contract'
  }
  if (SchemaAST.isObjectKeyword(ast)) return {}
  if (SchemaAST.isDeclaration(ast)) return new Uint8Array(8).fill(1)
  if (SchemaAST.isNever(ast)) throw new Error('never has no contract witness')
  if (SchemaAST.isSuspend(ast)) {
    const suspended = ast.thunk()
    if (ancestors.has(suspended)) return {}
    return astWitness(suspended, path, new Set([...ancestors, suspended]))
  }
  if (SchemaAST.isUnion(ast)) {
    const viable = ast.types.filter((member) =>
      !SchemaAST.isUndefined(member) && !SchemaAST.isNever(member) &&
      !SchemaAST.isNull(member))
    return astWitness(viable[0] ?? ast.types[0]!, path, ancestors)
  }
  if (SchemaAST.isArrays(ast)) {
    if (ast.elements.length > 0) {
      return ast.elements.map((element, index) =>
        astWitness(element, [...path, String(index)], ancestors))
    }
    const element = ast.rest[0]
    return element === undefined
      ? []
      : [astWitness(element, [...path, '0'], ancestors)]
  }
  if (SchemaAST.isObjects(ast)) {
    if (ancestors.has(ast)) return {}
    const nested = new Set([...ancestors, ast])
    const result: Record<string, unknown> = {}
    const typeProperty = ast.propertySignatures.find(({ name }) => name === 'type')
    const typeLiteral = typeProperty !== undefined &&
      SchemaAST.isLiteral(typeProperty.type) &&
      typeof typeProperty.type.literal === 'string'
      ? typeProperty.type.literal
      : undefined
    const objectPath = typeLiteral === undefined ? path : [...path, typeLiteral]
    for (const property of ast.propertySignatures) {
      const name = String(property.name)
      const members = SchemaAST.isUnion(property.type)
        ? property.type.types
        : [property.type]
      if (members.every((member) =>
        SchemaAST.isUndefined(member) || SchemaAST.isNever(member))) {
        continue
      }
      result[name] = astWitness(property.type, [...objectPath, name], nested)
    }
    for (const index of ast.indexSignatures) {
      result[`${path.at(-1) ?? 'entry'}Key`] = astWitness(
        index.type, [...objectPath, 'entry'], nested,
      )
    }
    return result
  }
  throw new Error(`unsupported Effect AST witness: ${ast._tag}`)
}

export function schemaWitnesses(ast: SchemaAST.AST): readonly unknown[] {
  const flatten = (current: SchemaAST.AST): readonly SchemaAST.AST[] =>
    SchemaAST.isUnion(current)
      ? current.types.flatMap(flatten)
      : [current]
  const variants = flatten(ast)
  return variants.map((variant) => astWitness(variant, [], new Set()))
}

function astShape(ast: SchemaAST.AST, ancestors: ReadonlySet<SchemaAST.AST>): string {
  if (SchemaAST.isLiteral(ast)) return `literal(${JSON.stringify(ast.literal)})`
  if (SchemaAST.isString(ast)) return 'string'
  if (SchemaAST.isNumber(ast)) return 'number'
  if (SchemaAST.isBoolean(ast)) return 'boolean'
  if (SchemaAST.isBigInt(ast)) return 'bigint'
  if (SchemaAST.isNull(ast)) return 'null'
  if (SchemaAST.isUndefined(ast)) return 'undefined'
  if (SchemaAST.isUnknown(ast)) return 'unknown'
  if (SchemaAST.isAny(ast)) return 'any'
  if (SchemaAST.isNever(ast)) return 'never'
  if (SchemaAST.isObjectKeyword(ast)) return 'object'
  if (SchemaAST.isSuspend(ast)) {
    const suspended = ast.thunk()
    if (ancestors.has(suspended)) {
      return `ref(${SchemaAST.resolveIdentifier(suspended) ?? 'recursive'})`
    }
    return astShape(suspended, ancestors)
  }
  if (ancestors.has(ast)) {
    return `ref(${SchemaAST.resolveIdentifier(ast) ?? 'recursive'})`
  }
  const nested = new Set(ancestors)
  nested.add(ast)
  if (SchemaAST.isUnion(ast)) {
    return ast.types.map((member) => astShape(member, nested)).sort().join('|')
  }
  if (SchemaAST.isArrays(ast)) {
    const elements = ast.elements.map((element) => astShape(element, nested))
    const rest = ast.rest.map((element) => `...${astShape(element, nested)}`)
    return `[${[...elements, ...rest].join(',')}]`
  }
  if (SchemaAST.isObjects(ast)) {
    const properties = ast.propertySignatures
      .map((property) => fieldToken(property, nested))
      .sort((left, right) => left.localeCompare(right))
    const indexes = ast.indexSignatures.map((index) =>
      `[${astShape(index.parameter, nested)}]:${astShape(index.type, nested)}`,
    ).sort()
    return `{${[...properties, ...indexes].join(',')}}`
  }
  if (SchemaAST.isEnum(ast)) return 'enum'
  if (SchemaAST.isTemplateLiteral(ast)) return 'template'
  if (SchemaAST.isDeclaration(ast)) {
    return `declaration(${SchemaAST.resolveIdentifier(ast) ?? 'anonymous'})`
  }
  return `ast(${SchemaAST.resolveIdentifier(ast) ?? 'anonymous'})`
}

function fieldToken(
  property: SchemaAST.PropertySignature,
  ancestors: ReadonlySet<SchemaAST.AST>,
): string {
  const name = String(property.name)
  const optional = SchemaAST.isOptional(property.type) ? '?' : ''
  return `${name}${optional}:${astShape(property.type, ancestors)}`
}

function objectShape(ast: SchemaAST.Objects): string {
  const ancestors = new Set<SchemaAST.AST>([ast])
  const fields = ast.propertySignatures
    .map((property) => fieldToken(property, ancestors))
    .sort((left, right) => left.localeCompare(right))
    .join(',')
  return `{${fields}}`
}

export function schemaFieldContracts(
  ast: SchemaAST.AST,
): Map<string, Set<string>> {
  const contracts = new Map<string, Set<string>>()
  const visit = (current: SchemaAST.AST, inherited?: string): void => {
    const identifier = SchemaAST.resolveIdentifier(current) ?? inherited
    if (identifier !== undefined && SchemaAST.isObjects(current)) {
      const variants = contracts.get(identifier) ?? new Set<string>()
      variants.add(objectShape(current))
      contracts.set(identifier, variants)
    }
    if (SchemaAST.isUnion(current)) {
      for (const member of current.types) visit(member, identifier)
    }
  }
  visit(ast)
  return contracts
}

export function mergeFieldContracts(
  ...catalogs: readonly SchemaFieldContracts[]
): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>()
  for (const catalog of catalogs) {
    for (const [identifier, variants] of catalog) {
      const current = merged.get(identifier) ?? new Set<string>()
      for (const variant of variants) current.add(variant)
      merged.set(identifier, current)
    }
  }
  return merged
}

export function fieldContractViolations(
  expected: SchemaFieldContracts,
  actual: SchemaFieldContracts,
): string[] {
  const violations: string[] = []
  for (const [identifier, expectedVariants] of expected) {
    const actualVariants = actual.get(identifier)
    if (actualVariants === undefined) {
      violations.push(`missing schema: ${identifier}`)
      continue
    }
    const expectedShape = [...expectedVariants].sort().join('|')
    const actualShape = [...actualVariants].sort().join('|')
    if (actualShape !== expectedShape) {
      violations.push(`field shape: ${identifier}`)
    }
  }
  for (const identifier of actual.keys()) {
    if (!expected.has(identifier)) violations.push(`unknown schema: ${identifier}`)
  }
  return violations
}

export function renderNativeFieldShapeCatalog(
  schemaNames: readonly string[],
  contracts: SchemaFieldContracts,
): string {
  const rows = schemaNames.map((schema, index) => {
    const variants = contracts.get(schema)
    if (variants === undefined) {
      throw new Error(`Effect Schema identifier is missing: ${schema}`)
    }
    const shape = [...variants].sort().join('|')
    const continuation = index === schemaNames.length - 1 ? '' : ' \\'
    return `  X(${schema}, ${JSON.stringify(shape)})${continuation}`
  })
  return [
    '// BEGIN GENERATED EXTERNAL MESSAGE FIELD SHAPES',
    '#define SYRNIKE_NATIVE_EXTERNAL_FIELD_SHAPES(X) \\',
    ...rows,
    '// END GENERATED EXTERNAL MESSAGE FIELD SHAPES',
  ].join('\n')
}
