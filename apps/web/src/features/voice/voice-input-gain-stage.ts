export class VoiceInputGainStage {
  #source: MediaStreamAudioSourceNode | null = null
  #gain: GainNode | null = null
  #destination: MediaStreamAudioDestinationNode | null = null
  #outputTrack: MediaStreamTrack | null = null

  start(context: AudioContext, track: MediaStreamTrack, volume: number) {
    const source = context.createMediaStreamSource(new MediaStream([track]))
    const gain = context.createGain()
    const destination = context.createMediaStreamDestination()

    gain.gain.value = volume
    source.connect(gain)
    gain.connect(destination)

    this.#source = source
    this.#gain = gain
    this.#destination = destination
    this.#outputTrack = destination.stream.getAudioTracks()[0] ?? null

    return this.#outputTrack
  }

  destroy() {
    this.#source?.disconnect()
    this.#gain?.disconnect()
    this.#destination?.disconnect()
    this.#outputTrack?.stop()
    this.#source = null
    this.#gain = null
    this.#destination = null
    this.#outputTrack = null
  }
}
