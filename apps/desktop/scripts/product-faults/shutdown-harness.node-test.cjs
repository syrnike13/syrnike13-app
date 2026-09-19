const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')

const source = readFileSync(join(__dirname, 'shutdown-harness.cjs'), 'utf8')

// Run the complete harness with a deterministic clock and in-memory fixture.
// Delay the final poll to model observer scheduling latency across the deadline.
async function runFixture({ closeAt = 4899, exitAt = [200, 100] } = {}) {
  let now = 0
  let shutdownStarted = false
  let finished = false
  let summary
  const timers = []
  const files = new Map()
  const polls = [[], []]
  const killed = new Set()
  const closed = []
  const root = resolve('shutdown-harness-test-fixture')
  const schedule = (callback, ms) => {
    const observerDelay = ms === 5 && now === 4895 ? 5 : 0
    timers.push({ at: now + ms + observerDelay, callback })
  }
  const harness = {}
  runInNewContext(source, {
    exports: harness,
    console: { log() {} },
    setTimeout: schedule,
    process: {
      kill(pid, signal) {
        if (signal === 'SIGKILL') killed.add(pid)
      },
    },
    require(name) {
      if (name === 'node:perf_hooks') return { performance: { now: () => now } }
      if (name === 'node:fs') return {
        existsSync: path => files.has(path),
        mkdirSync() {},
        readFileSync: path => files.get(path),
        readdirSync: () => [],
        unlinkSync: path => files.delete(path),
        writeFileSync: (path, text) => files.set(path, text),
      }
      return require(name)
    },
  })
  const running = harness.run({
    directory: join(root, 'report'),
    mediaRoot: join(root, 'media'),
    point: 'stop',
    count: 1,
    broker: {
      openReceiverProcess(pid) {
        const index = pid - 101
        return {
          hasExited() {
            if (!shutdownStarted) return false
            polls[index].push(now)
            return now >= exitAt[index] || killed.has(pid)
          },
          close() { closed.push(pid) },
        }
      },
    },
    launch: async () => ({
      close() {
        shutdownStarted = true
        return new Promise(resolve => schedule(resolve, closeAt))
      },
    }),
    inventory: async () => ({ mainPid: 101, mediaPids: [102] }),
    enterFault: async () => {
      files.set(join(root, 'native-test-fault-held-102-stop.json'),
        JSON.stringify({ point: 'stop', call: 1, pid: 102 }) + '\n')
    },
  }).then(value => { summary = value; finished = true })

  while (!finished) {
    // Flush promise callbacks before advancing to the next scheduled observer.
    await new Promise(resolve => setImmediate(resolve))
    if (finished) break
    assert.ok(timers.length > 0, 'fixture must have a pending timer')
    timers.sort((left, right) => left.at - right.at)
    const next = timers.shift()
    now = next.at
    next.callback()
  }
  await running
  assert.deepEqual(closed, [101, 102])
  return { result: JSON.parse(JSON.stringify(summary.results[0])), polls, killed }
}

test('samples every process during close and uses independent completion timestamps', async () => {
  const { result, polls, killed } = await runFixture()
  assert.equal(result.shutdownBudgetMs, 4900)
  assert.equal(result.passed, true)
  assert.equal(result.closeElapsedMs, 4899)
  assert.deepEqual(result.firstObservedExitMs, [200, 100])
  assert.equal(result.completionElapsedMs,
    Math.max(result.closeElapsedMs, ...result.firstObservedExitMs))
  assert.equal(result.elapsedMs, 4905)
  for (const samples of polls) {
    assert.ok(samples.includes(5), 'each handle is sampled before close resolves')
    assert.ok(samples.includes(4895), 'exited handles remain sampled during close')
  }
  assert.equal(killed.size, 0)
})

test('rejects close completion beyond the unchanged 4900 ms budget', async () => {
  const { result } = await runFixture({ closeAt: 4901 })
  assert.equal(result.passed, false)
  assert.equal(result.completionElapsedMs, 4901)
  assert.equal(result.failure, 'product_shutdown_deadline')
})

test('fails the deadline and force-kills a remaining process', async () => {
  const { result, killed } = await runFixture({ exitAt: [200, Infinity] })
  assert.equal(result.passed, false)
  assert.equal(result.completionElapsedMs, null)
  assert.deepEqual(result.firstObservedExitMs, [200, null])
  assert.equal(result.failure, 'product_shutdown_deadline')
  assert.equal(result.forcedFixtureCleanup, true)
  assert.deepEqual([...killed], [102])
})
