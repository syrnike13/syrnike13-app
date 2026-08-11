import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const preloadPath = path.join(desktopRoot, 'out/preload/index.cjs')
const source = readFileSync(preloadPath, 'utf8')
const externalRequires = Array.from(
  source.matchAll(/\brequire\((['"])([^'"]+)\1\)/g),
  (match) => match[2],
).filter((specifier) => specifier !== 'electron')

if (externalRequires.length > 0) {
  console.error(
    [
      'Sandboxed desktop preload contains external package imports:',
      ...Array.from(new Set(externalRequires)).map(
        (specifier) => `- ${specifier}`,
      ),
      '',
      'Bundle preload dependencies in tsup.config.ts.',
    ].join('\n'),
  )
  process.exit(1)
}
