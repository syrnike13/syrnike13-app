import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Schema } from 'effect'

const env = Schema.decodeUnknownSync(Schema.Struct({
  MEDIA_LAB_AUDIO_BIN: Schema.String, MEDIA_LAB_AUDIO_CAPTURE_REPORT: Schema.String,
}))(process.env)
const children: ReturnType<typeof spawn>[] = []
function start(name: string, args: string[]) {
  const child = spawn(path.join(env.MEDIA_LAB_AUDIO_BIN, name), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let output = ''
  const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-100_000) }
  child.stdout?.on('data', append); child.stderr?.on('data', append)
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${name}: ${code}: ${output}`)))
  })
  void done.catch(() => undefined)
  return { child, done, output: () => output }
}
const Sample = Schema.Struct({
  cycle: Schema.Number, packets: Schema.Number, activePackets: Schema.Number, peakRms: Schema.Number,
  maximumAgeUs: Schema.Number, failure: Schema.Number, handlesDelta: Schema.Number,
  clientsAfterStop: Schema.Number, threadsAfterStop: Schema.Number,
})
const samples = (output: string) => output.split(/\r?\n/).filter(line => line.startsWith('AUDIO_CAPTURE_SAMPLE '))
  .map(line => Schema.decodeUnknownSync(Sample)(JSON.parse(line.slice('AUDIO_CAPTURE_SAMPLE '.length))))
let timer: ReturnType<typeof setTimeout> | undefined
try {
  const fixture = start('audio_sync_fixture.exe', [])
  const readyBy = performance.now() + 5000
  while (!fixture.output().includes('AUDIO_FIXTURE_READY') && performance.now() < readyBy)
    await new Promise(resolve => setTimeout(resolve, 50))
  if (!fixture.output().includes('AUDIO_FIXTURE_READY') || !fixture.child.pid) throw new Error('Audio fixture did not start')
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Capture matrix exceeded 75 seconds')), 75_000) })
  const lifecycle = start('audio_capture_lab.exe', ['include', String(fixture.child.pid), '1100', '30'])
  await Promise.race([lifecycle.done, deadline])
  const cycles = samples(lifecycle.output())
  if (cycles.length !== 30 || cycles.some(sample => sample.failure !== -1 || sample.clientsAfterStop !== 0 || sample.threadsAfterStop !== 0 || sample.packets < 50))
    throw new Error('Capture lifecycle did not drain all 30 cycles')
  // The first two starts include Windows audio service/cache initialization.
  const warm = cycles.slice(1)
  if (Math.max(...warm.map(sample => sample.handlesDelta)) - Math.min(...warm.map(sample => sample.handlesDelta)) > 2)
    throw new Error('Post-warmup process handles grew across capture cycles')
  // This Node process renders nothing. Its child fixture is the only source
  // of the coded sound, proving descendants rather than direct-process audio.
  const descendants = start('audio_capture_lab.exe', ['include', String(process.pid), '10000', '1'])
  await Promise.race([descendants.done, deadline])
  const childTree = samples(descendants.output())
  if (childTree.length !== 1 || childTree[0]!.failure !== -1 || childTree[0]!.activePackets < 20 || childTree[0]!.clientsAfterStop || childTree[0]!.threadsAfterStop)
    throw new Error('The selected parent did not capture its audible child')
  await writeFile(env.MEDIA_LAB_AUDIO_CAPTURE_REPORT, JSON.stringify({ accepted: true, cycles, childTree }, null, 2))
  console.log(`Audio capture matrix: ${env.MEDIA_LAB_AUDIO_CAPTURE_REPORT}`)
} finally {
  clearTimeout(timer)
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    child.kill(); await closed
  }
}
