import { createSpaStaticServer } from './spa-server.mjs'

const port = Number.parseInt(process.env.PORT || '5000', 10)
const { server, listen } = createSpaStaticServer({
  clientDir: 'dist/client',
  host: '0.0.0.0',
  port,
})

await listen()
console.log(`syrnike13 web listening on ${port}`)

process.on('SIGTERM', () => {
  server.close()
})
