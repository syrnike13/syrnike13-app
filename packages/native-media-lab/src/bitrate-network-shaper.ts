import { SignalRequest, SignalResponse } from '@livekit/protocol'
import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

/** A disposable lab link. Only publisher video RTP crosses the finite bucket;
 * audio, STUN/DTLS and RTCP retain their independent control/audio reservation. */
export class VideoPacketBudget {
  static readonly maximumPackets = 64
  static readonly maximumAgeMs = 40
  private readonly queue: { bytes: Buffer; at: number; send: (bytes: Buffer) => void }[] = []
  private tokens = 0
  private lastMs: number | undefined
  offeredBytes = 0
  deliveredBytes = 0
  droppedPackets = 0
  maximumDepth = 0
  maximumDeliveryAgeMs = 0
  get depth() { return this.queue.length }
  offer(bytes: Buffer, now: number, send: (bytes: Buffer) => void) {
    this.offeredBytes += bytes.length
    if (this.queue.length === VideoPacketBudget.maximumPackets) {
      this.queue.shift(); ++this.droppedPackets
    }
    this.queue.push({ bytes, at: now, send })
    this.maximumDepth = Math.max(this.maximumDepth, this.queue.length)
  }
  tick(now: number, bitrate: number) {
    if (!Number.isFinite(bitrate) || bitrate <= 0) throw new Error('Invalid test link bitrate')
    const burst = Math.max(1500, bitrate / 8 * 0.02)
    this.tokens = Math.min(burst, this.tokens + bitrate / 8000 * Math.max(0, now - (this.lastMs ?? now)))
    this.lastMs = now
    while (this.queue.length) {
      const packet = this.queue[0]
      if (!packet) break
      const age = now - packet.at
      if (age > VideoPacketBudget.maximumAgeMs) {
        this.queue.shift(); ++this.droppedPackets; continue
      }
      if (packet.bytes.length > this.tokens) break
      this.queue.shift(); this.tokens -= packet.bytes.length
      this.deliveredBytes += packet.bytes.length
      this.maximumDeliveryAgeMs = Math.max(this.maximumDeliveryAgeMs, age)
      packet.send(packet.bytes)
    }
  }
  clear() { this.droppedPackets += this.queue.length; this.queue.length = 0 }
}

export function rewriteLabCandidate(candidate: string, serverPort: number, proxyPort: number, address?: string): string | undefined {
  if (!candidate) return candidate
  const parts = candidate.trim().split(/\s+/)
  if (parts.length < 8 || parts[2]?.toLowerCase() !== 'udp' || Number(parts[5]) !== serverPort)
    return undefined
  parts[5] = String(proxyPort)
  if (address) parts[4] = address
  return parts.join(' ')
}

function bytes(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
}

export function labIpv4Address() {
  const address = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal && entry.mac !== '00:00:00:00:00:00')?.address
  if (!address) throw new Error('Lab requires a local IPv4 interface for ICE')
  return address
}

export async function startBitrateNetworkShaper(options: {
  serverSignalPort: number; serverUdpPort: number; signalPort: number; udpPort: number;
  limit: () => number;
}) {
  const budget = new VideoPacketBudget()
  const peers = new Map<string, Socket>()
  const connections = new Set<WebSocket>()
  const front = createSocket('udp4')
  const signaling = new WebSocketServer({ host: '127.0.0.1', port: options.signalPort, maxPayload: 1 << 20 })
  const audioPayloads = new Set([111])
  const localAddresses = new Set(Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? []))
  const proxyAddress = labIpv4Address()
  let failure: string | undefined, rewrites = 0, stopping = false, receivedPackets = 0, responsePackets = 0
  const fail = (message: string) => { failure ??= message }
  const peerFor = (address: string, port: number) => {
    const key = `${address}:${port}`
    const existing = peers.get(key)
    if (existing) return existing
    if (peers.size >= 4) throw new Error('Publisher exceeded four UDP transports')
    const socket = createSocket('udp4'); peers.set(key, socket)
    socket.on('error', () => fail('UDP upstream socket failed'))
    socket.on('message', response => { ++responsePackets; if (!stopping) front.send(response, port, address) })
    socket.bind(0, proxyAddress)
    return socket
  }
  front.on('error', () => fail('UDP proxy socket failed'))
  signaling.on('error', () => fail('Signaling proxy failed'))
  front.on('message', (packet, remote) => {
    if (stopping || !localAddresses.has(remote.address)) return
    ++receivedPackets
    let socket: Socket
    try { socket = peerFor(remote.address, remote.port) } catch { fail('Publisher exceeded four UDP transports'); return }
    const send = (value: Buffer) => {
      if (!stopping) socket.send(value, options.serverUdpPort, proxyAddress)
    }
    const first = packet[0] ?? 0, second = packet[1] ?? 0
    const videoRtp = first >= 128 && first < 192 && !(second >= 192 && second <= 223) &&
      !audioPayloads.has(second & 127)
    if (videoRtp) budget.offer(packet, performance.now(), send)
    else send(packet)
  })
  const rewriteSdp = (sdp: string) => sdp.split(/\r?\n/).flatMap(line => {
    if (!line.startsWith('a=candidate:')) return [line]
    const rewritten = rewriteLabCandidate(line.slice(2), options.serverUdpPort, options.udpPort, proxyAddress)
    if (rewritten === undefined) return []
    ++rewrites; return [`a=${rewritten}`]
  }).join('\r\n')
  signaling.on('connection', (client, request) => {
    if (connections.size >= 2) { fail('Unexpected publisher signaling reconnect'); client.terminate(); return }
    const upstream = new WebSocket(`ws://127.0.0.1:${options.serverSignalPort}${request.url ?? '/rtc'}`,
      { maxPayload: 1 << 20,
        headers: request.headers.authorization ? { authorization: request.headers.authorization } : {} })
    connections.add(client); connections.add(upstream)
    const pending: Buffer[] = []
    const close = () => { client.terminate(); upstream.terminate(); pending.length = 0 }
    client.on('error', () => { if (!stopping) fail('Publisher signaling failed'); close() })
    upstream.on('error', () => { if (!stopping) fail('SFU signaling failed'); close() })
    client.on('close', close); upstream.on('close', close)
    upstream.on('open', () => { for (const item of pending) upstream.send(item); pending.length = 0 })
    client.on('message', async data => {
      let value = bytes(data)
      try {
        const decoded = SignalRequest.fromBinary(value)
        const message = decoded.message
        // Give the ICE-lite SFU a real remote candidate, but only the owned
        // upstream socket. Both directions therefore cross this link.
        if (message.case === 'trickle') {
          const candidate: unknown = JSON.parse(message.value.candidateInit)
          if (typeof candidate !== 'object' || candidate === null || !('candidate' in candidate) || typeof candidate.candidate !== 'string')
            throw new Error('Invalid publisher candidate')
          const parts = candidate.candidate.trim().split(/\s+/)
          if (parts[2]?.toLowerCase() !== 'udp' || parts[4] !== proxyAddress) return
          const socket = peerFor(proxyAddress, Number(parts[5]))
          let port = 0
          try { port = socket.address().port } catch {
            await new Promise<void>((resolve, reject) => { socket.once('listening', resolve); socket.once('error', reject) })
            port = socket.address().port
          }
          parts[5] = String(port)
          message.value.candidateInit = JSON.stringify({ ...candidate, candidate: parts.join(' ') })
          value = Buffer.from(decoded.toBinary())
        }
        if (message.case === 'offer' || message.case === 'answer') {
          message.value.sdp = message.value.sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:')).join('\r\n')
          value = Buffer.from(decoded.toBinary())
        }
        if (message.case === 'offer' || message.case === 'answer')
          for (const match of message.value.sdp.matchAll(/a=rtpmap:(\d+) opus\//gi))
            if (audioPayloads.size < 16) audioPayloads.add(Number(match[1]))
        if (upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > 1 << 20) throw new Error('Signaling backlog')
          upstream.send(value)
        } else {
          if (pending.length >= 16) throw new Error('Signaling startup backlog')
          pending.push(value)
        }
      } catch { fail('Publisher signal decode/backlog failed'); close() }
    })
    upstream.on('message', data => {
      try {
        const response = SignalResponse.fromBinary(bytes(data))
        const message = response.message
        if (message.case === 'answer' || message.case === 'offer') message.value.sdp = rewriteSdp(message.value.sdp)
        if (message.case === 'trickle') {
          const candidate: unknown = JSON.parse(message.value.candidateInit)
          if (typeof candidate !== 'object' || candidate === null ||
              !('candidate' in candidate) || typeof candidate.candidate !== 'string')
            throw new Error('Invalid candidate')
          const rewritten = rewriteLabCandidate(candidate.candidate, options.serverUdpPort, options.udpPort, proxyAddress)
          if (rewritten === undefined) return
          message.value.candidateInit = JSON.stringify({ ...candidate, candidate: rewritten }); ++rewrites
        }
        if (message.case === 'join') message.value.iceServers = []
        if (client.bufferedAmount > 1 << 20) throw new Error('Signaling backlog')
        if (client.readyState === WebSocket.OPEN) client.send(response.toBinary())
      } catch { fail('SFU signal decode/backlog failed'); close() }
    })
  })
  await new Promise<void>((resolve, reject) => {
    front.once('error', reject)
    front.bind(options.udpPort, proxyAddress, () => { front.off('error', reject); resolve() })
  })
  const timer = setInterval(() => budget.tick(performance.now(), options.limit()), 2)
  return {
    snapshot: () => ({ failure, rewrites, receivedPackets, responsePackets, peers: peers.size, depth: budget.depth,
      maximumDepth: budget.maximumDepth, offeredBytes: budget.offeredBytes,
      deliveredBytes: budget.deliveredBytes, droppedPackets: budget.droppedPackets,
      maximumDeliveryAgeMs: budget.maximumDeliveryAgeMs }),
    close: async () => {
      stopping = true; clearInterval(timer); budget.clear()
      for (const connection of connections) connection.terminate()
      for (const peer of peers.values()) peer.close()
      front.close()
      await new Promise<void>(resolve => signaling.close(() => resolve()))
    },
  }
}
