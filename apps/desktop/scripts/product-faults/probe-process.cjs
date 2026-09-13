const { spawn } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Test-only child ownership and bounded numeric protocol collection. Unrelated
// SDK stdout/stderr is discarded because it may contain fixture credentials.
exports.startProbe = ({ executable, args = [], env, prefixes }) => {
  const child = spawn(executable, args, {
    windowsHide: true, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  let buffer = ''
  let failure
  let exited = false
  let exitCode
  const done = new Promise(resolve => {
    child.once('error', () => { failure = 'probe_launch_failed'; exited = true; resolve() })
    child.once('close', code => { exited = true; exitCode = code; resolve() })
  })
  child.stderr.on('data', () => {})
  child.stdin.on('error', () => { failure = 'probe_input_failed' })
  child.stdout.on('data', chunk => {
    if (failure) return
    buffer += chunk.toString()
    if (buffer.length > 131_072) {
      failure = 'probe_output_capacity'
      child.kill()
      return
    }
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      const prefix = prefixes.find(value => line.startsWith(`${value} `))
      if (!prefix) continue
      try {
        if (events.length >= 512) throw new Error('capacity')
        events.push({ type: prefix, value: JSON.parse(line.slice(prefix.length + 1)) })
      } catch {
        failure = 'probe_protocol_failed'
        child.kill()
        return
      }
    }
  })
  return {
    async take(predicate, label, timeoutMs = 5_000) {
      const deadline = performance.now() + timeoutMs
      while (performance.now() < deadline) {
        if (failure) throw new Error(failure)
        const index = events.findIndex(predicate)
        if (index >= 0) return events.splice(index, 1)[0].value
        if (exited) throw new Error('probe_exited_without_expected_evidence')
        await delay(10)
      }
      throw new Error(label)
    },
    command(value) {
      if (exited || failure || !['snapshot', 'begin', 'finish', 'stop'].includes(value))
        throw new Error('probe_command_rejected')
      child.stdin.write(`${value}\n`)
    },
    async stop() {
      if (!exited) child.kill()
      await Promise.race([done, delay(2_000)])
      if (!exited) throw new Error('probe_exit_deadline')
    },
    async finished(timeoutMs = 5_000) {
      await Promise.race([done, delay(timeoutMs)])
      if (!exited || failure || exitCode !== 0) {
        const error = new Error('probe_failed_or_exit_deadline')
        error.probeStatus = { exited, exitCode, failure }
        throw error
      }
    },
  }
}
