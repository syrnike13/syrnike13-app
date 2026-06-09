const PCM_RING_HEADER_INT32S = 8
const PCM_RING_DATA_OFFSET_BYTES = 64
const PCM_RING_SAMPLES_PER_PACKET = 960
const PCM_RING_MAX_CHANNELS = 2
const PCM_RING_SLOT_COUNT = 128
const PCM_RING_FLOATS_PER_SLOT =
  PCM_RING_SAMPLES_PER_PACKET * PCM_RING_MAX_CHANNELS

const PCM_RING_WRITE_SEQ = 0
const PCM_RING_READ_SEQ = 1
const PCM_RING_PACKET_SAMPLES = 2
const PCM_RING_CHANNELS = 3
const PCM_RING_ACTIVE = 4
const PCM_RING_DROPPED_PACKETS = 5

class NativePcmJitterBufferProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const processorOptions = options.processorOptions || {}
    this.channels = processorOptions.channels || 1
    this.targetBufferFrames = processorOptions.targetBufferFrames || 7680
    this.maxBufferFrames = processorOptions.maxBufferFrames || 20160
    this.ringMode = Boolean(processorOptions.sharedBuffer)
    this.queue = []
    this.queuedFrames = 0
    this.started = false
    this.ended = false
    this.droppedFrames = 0
    this.underruns = 0
    this.framesSinceMetrics = 0
    this.packetOffset = 0
    this.packetFrames = 0
    this.currentSlot = 0

    if (this.ringMode) {
      this.sharedBuffer = processorOptions.sharedBuffer
      this.header = new Int32Array(this.sharedBuffer, 0, PCM_RING_HEADER_INT32S)
      this.samples = new Float32Array(
        this.sharedBuffer,
        PCM_RING_DATA_OFFSET_BYTES,
        PCM_RING_SLOT_COUNT * PCM_RING_FLOATS_PER_SLOT,
      )
      this.ringChannels = Atomics.load(this.header, PCM_RING_CHANNELS) || this.channels
      this.packetSamples = Atomics.load(this.header, PCM_RING_PACKET_SAMPLES) || PCM_RING_SAMPLES_PER_PACKET
      this.targetPackets = Math.max(
        1,
        Math.ceil(this.targetBufferFrames / this.packetSamples),
      )
      return
    }

    this.port.onmessage = (event) => {
      const message = event.data
      if (!message || message.type === 'end') {
        this.ended = true
        this.queue = []
        this.queuedFrames = 0
        return
      }
      if (message.type !== 'chunk' || !message.buffer) return
      const samples = new Float32Array(message.buffer)
      const frames = Math.floor(samples.length / this.channels)
      if (frames <= 0) return
      this.queue.push({ samples, offsetFrames: 0, frames })
      this.queuedFrames += frames
      while (this.queuedFrames > this.maxBufferFrames && this.queue.length > 0) {
        const packet = this.queue.shift()
        if (!packet) break
        const remaining = packet.frames - packet.offsetFrames
        this.queuedFrames -= remaining
        this.droppedFrames += remaining
      }
    }
  }

  processRingOutput(output) {
    const frames = output[0].length
    const header = this.header
    const channels = this.ringChannels

    if (Atomics.load(header, PCM_RING_ACTIVE) !== 1) {
      for (const channel of output) channel.fill(0)
      return
    }

    let writeSeq = Atomics.load(header, PCM_RING_WRITE_SEQ)
    let readSeq = Atomics.load(header, PCM_RING_READ_SEQ)

    if (!this.started) {
      for (const channel of output) channel.fill(0)
      if (writeSeq - readSeq >= this.targetPackets) {
        this.started = true
      }
      this.postMetrics(frames, header)
      return
    }

    for (let frame = 0; frame < frames; frame += 1) {
      if (this.packetOffset >= this.packetFrames) {
        writeSeq = Atomics.load(header, PCM_RING_WRITE_SEQ)
        readSeq = Atomics.load(header, PCM_RING_READ_SEQ)
        if (readSeq >= writeSeq) {
          this.underruns += 1
          for (let channel = 0; channel < output.length; channel += 1) {
            output[channel][frame] = 0
          }
          this.packetOffset = 0
          this.packetFrames = 0
          continue
        }

        this.currentSlot = readSeq % PCM_RING_SLOT_COUNT
        this.packetFrames = this.packetSamples
        this.packetOffset = 0
        Atomics.store(header, PCM_RING_READ_SEQ, readSeq + 1)
      }

      const sourceFrame = this.packetOffset
      const slotOffset = this.currentSlot * PCM_RING_FLOATS_PER_SLOT
      for (let channel = 0; channel < output.length; channel += 1) {
        const sourceChannel = Math.min(channel, channels - 1)
        output[channel][frame] =
          this.samples[slotOffset + sourceFrame * channels + sourceChannel] || 0
      }
      this.packetOffset += 1
    }

    this.droppedFrames = Atomics.load(header, PCM_RING_DROPPED_PACKETS) * this.packetSamples
    this.postMetrics(frames, header)
  }

  processQueueOutput(output) {
    const frames = output[0].length

    if (!this.started) {
      for (const channel of output) channel.fill(0)
      if (this.queuedFrames >= this.targetBufferFrames) this.started = true
      this.postMetrics(frames)
      return
    }

    for (let frame = 0; frame < frames; frame += 1) {
      const packet = this.queue[0]
      if (!packet) {
        this.underruns += 1
        for (let channel = 0; channel < output.length; channel += 1) {
          output[channel][frame] = 0
        }
        continue
      }

      const sourceFrame = packet.offsetFrames
      for (let channel = 0; channel < output.length; channel += 1) {
        const sourceChannel = Math.min(channel, this.channels - 1)
        output[channel][frame] =
          packet.samples[sourceFrame * this.channels + sourceChannel] || 0
      }

      packet.offsetFrames += 1
      this.queuedFrames -= 1
      if (packet.offsetFrames >= packet.frames) this.queue.shift()
    }

    this.postMetrics(frames)
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return !this.ended

    if (this.ringMode) {
      this.processRingOutput(output)
      return !this.ended
    }

    this.processQueueOutput(output)
    return !this.ended
  }

  postMetrics(frames, header = null) {
    this.framesSinceMetrics += frames
    if (this.framesSinceMetrics < sampleRate / 2) return
    this.framesSinceMetrics = 0
    const metrics = {
      type: 'metrics',
      queuedFrames:
        this.ringMode && header
          ? (Atomics.load(header, PCM_RING_WRITE_SEQ) -
              Atomics.load(header, PCM_RING_READ_SEQ)) *
            this.packetSamples
          : this.queuedFrames,
      droppedFrames: this.droppedFrames,
      underruns: this.underruns,
      started: this.started,
      ringMode: this.ringMode,
    }
    this.port.postMessage(metrics)
  }
}

registerProcessor('native-pcm-jitter-buffer', NativePcmJitterBufferProcessor)
