import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const channelSource = resolve(
  root,
  'services/backend/crates/core/permissions/src/models/channel.rs',
)
const globalSource = resolve(
  root,
  'services/backend/crates/core/permissions/src/models/global.rs',
)
const userSource = resolve(
  root,
  'services/backend/crates/core/permissions/src/models/user.rs',
)
const output = resolve(
  root,
  'apps/web/src/features/authorization/permission-bits.generated.ts',
)

function enumBits(source, enumName) {
  const body = source.match(
    new RegExp(`pub enum ${enumName} \\{([\\s\\S]*?)\\n\\}`),
  )?.[1]
  if (!body) throw new Error(`Could not find ${enumName}`)

  return [...body.matchAll(/^\s*(\w+)\s*=\s*1\s*<<\s*(\d+),/gm)].map(
    ([, name, bit]) => ({ name, bit: Number(bit) }),
  )
}

function renderObject(name, entries) {
  const values = entries
    .map(({ name: entryName, bit }) => `  ${entryName}: permissionBit(${bit}),`)
    .join('\n')
  return `export const ${name} = {\n${values}\n} as const`
}

const channel = enumBits(await readFile(channelSource, 'utf8'), 'ChannelPermission')
const global = enumBits(await readFile(globalSource, 'utf8'), 'GlobalPermission')
const user = enumBits(await readFile(userSource, 'utf8'), 'UserPermission')
const generated = `// Generated from services/backend/crates/core/permissions/src/models/{channel,global,user}.rs.
// Run \`pnpm permissions:generate\` after changing the Rust permission enums.
import { permissionBit } from '#/lib/permission-bits'

${renderObject('ServerPermission', channel)}

${renderObject('GlobalPermission', global)}

${renderObject('UserPermission', user)}
`

await writeFile(output, generated)
