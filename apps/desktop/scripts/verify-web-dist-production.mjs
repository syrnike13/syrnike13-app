import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const webDist = path.resolve(desktopRoot, '../web/dist')

const forbiddenPatterns = [
  /127\.0\.0\.1:1470[2-5]/,
  /localhost:1470[2-5]/,
  /ws:\/\/127\.0\.0\.1:14703/,
  /http:\/\/127\.0\.0\.1:1470[2-5]/,
]

const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.txt',
])

const offenders = []

function scanFile(file) {
  if (!textExtensions.has(path.extname(file))) return

  const source = readFileSync(file, 'utf8')
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(source)) {
      offenders.push(path.relative(webDist, file))
      return
    }
  }
}

function scanDirectory(directory) {
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry)
    const stats = statSync(fullPath)

    if (stats.isDirectory()) {
      scanDirectory(fullPath)
    } else if (stats.isFile()) {
      scanFile(fullPath)
    }
  }
}

scanDirectory(webDist)

if (offenders.length > 0) {
  console.error(
    [
      'Desktop production build contains local backend URLs:',
      ...offenders.map((file) => `- ${file}`),
      '',
      'Use `pnpm --filter @syrnike13/web dev:local` for local backend development.',
      'Installed desktop builds must use the production client profile.',
    ].join('\n'),
  )
  process.exit(1)
}
