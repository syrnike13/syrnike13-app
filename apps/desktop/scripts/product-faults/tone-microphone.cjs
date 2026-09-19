// Install with Playwright addInitScript in the isolated browser observer only.
// The generated track replaces that fixture's microphone input; it is never
// connected to local speakers or installed in the desktop under test.
exports.installToneMicrophone = function installToneMicrophone() {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  const contexts = new Set()
  const gains = new Set()
  let silent = false
  window.toneMicrophoneFixture = {
    setSilent(value) {
      silent = Boolean(value)
      for (const gain of gains) gain.gain.value = silent ? 0 : 0.1
    },
    snapshot() { return { silent, contexts: contexts.size, sources: gains.size } },
  }
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (!constraints?.audio) return original(constraints)
    if (contexts.size >= 4) throw new Error('tone_microphone_capacity')
    const video = constraints.video ? await original({ video: constraints.video }) : null
    if (contexts.size >= 4) {
      video?.getTracks().forEach(track => track.stop())
      throw new Error('tone_microphone_capacity')
    }
    const context = new AudioContext({ sampleRate: 48000 })
    contexts.add(context)
    const oscillator = context.createOscillator()
    oscillator.frequency.value = 997
    const gain = context.createGain()
    gain.gain.value = silent ? 0 : 0.1
    gains.add(gain)
    const destination = context.createMediaStreamDestination()
    oscillator.connect(gain).connect(destination)
    const track = destination.stream.getAudioTracks()[0]
    const originalStop = track.stop.bind(track)
    let stopped = false
    track.stop = () => {
      if (stopped) return
      stopped = true
      originalStop()
      oscillator.stop()
      gains.delete(gain)
      // A failed close retains its capacity slot rather than permitting more
      // contexts to accumulate during repeated fixture failures.
      void context.close().then(() => contexts.delete(context), () => {})
    }
    oscillator.start()
    try {
      await context.resume()
      return new MediaStream([track, ...(video?.getVideoTracks() ?? [])])
    } catch (error) {
      track.stop()
      video?.getTracks().forEach(videoTrack => videoTrack.stop())
      throw error
    }
  }
}
