import { archiveAssets, createSpaStaticServer } from './spa-server.mjs'

const port = Number.parseInt(process.env.PORT || '5000', 10)
const clientDir = 'dist/client'
// Persistent directory for assets of previous builds (see archiveAssets).
const assetArchiveDir = process.env.ASSET_ARCHIVE_DIR || undefined

if (assetArchiveDir) {
  const retentionDays = Number.parseInt(
    process.env.ASSET_RETENTION_DAYS || '30',
    10,
  )
  const { archived, removed } = await archiveAssets({
    clientDir,
    archiveDir: assetArchiveDir,
    retentionDays,
  })
  console.log(
    `archived ${archived} assets, removed ${removed} older than ${retentionDays} days`,
  )
}

const { server, listen } = createSpaStaticServer({
  clientDir,
  assetArchiveDir,
  host: '0.0.0.0',
  port,
})

await listen()
console.log(`syrnike13 web listening on ${port}`)

process.on('SIGTERM', () => {
  server.close()
})
