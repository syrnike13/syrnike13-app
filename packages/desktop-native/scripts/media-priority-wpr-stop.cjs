const { spawn } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const delayMs = Number(process.argv[2])
const logPath = process.argv[5]
const wpr = process.argv[6]
const stopArgs = process.argv.slice(7)

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`
  try {
    appendFileSync(logPath, line)
  } catch {
    process.stderr.write(line)
  }
}

if (!Number.isFinite(delayMs) || delayMs <= 0 || !wpr || stopArgs.length === 0) {
  log(`invalid stopper arguments: ${JSON.stringify(process.argv.slice(2))}`)
  process.exit(1)
}

log(`armed delayMs=${delayMs} wpr=${wpr}`)
const startedAt = Date.now()
const timer = setInterval(() => {
  const elapsedMs = Date.now() - startedAt
  if (elapsedMs < delayMs) return
  clearInterval(timer)
  log(`stopping elapsedMs=${elapsedMs}`)
  const child = spawn(wpr, stopArgs, { windowsHide: true, stdio: 'inherit' })
  child.on('error', (error) => {
    log(`wpr spawn failed: ${error instanceof Error ? error.stack : error}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    log(`wpr exit code=${code} signal=${signal}`)
    process.exit(code ?? 1)
  })
}, 500)
