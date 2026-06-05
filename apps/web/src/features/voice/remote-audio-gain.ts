type AudioContextConstructor = typeof AudioContext

type BrowserWindowWithAudio = Window & {
  webkitAudioContext?: AudioContextConstructor
}

type RemoteAudioGainEntry = {
  context: AudioContext
  source: MediaElementAudioSourceNode
  gain: GainNode
}

const entries = new WeakMap<HTMLAudioElement, RemoteAudioGainEntry>()

function clampPlaybackGain(gain: number) {
  if (!Number.isFinite(gain)) return 1
  return Math.min(3, Math.max(0, Number(gain.toFixed(3))))
}

function audioContextConstructor() {
  if (typeof window === 'undefined') return undefined
  const browserWindow = window as BrowserWindowWithAudio
  return browserWindow.AudioContext ?? browserWindow.webkitAudioContext
}

export function applyRemoteAudioGain(
  element: HTMLAudioElement,
  gain: number,
) {
  const playbackGain = clampPlaybackGain(gain)
  element.dataset.livekitPlaybackGain = String(playbackGain)

  const existing = entries.get(element)
  if (existing) {
    existing.gain.gain.value = playbackGain
    void existing.context.resume().catch(() => {})
    return true
  }

  const Context = audioContextConstructor()
  if (!Context) return false

  try {
    const context = new Context()
    const source = context.createMediaElementSource(element)
    const gainNode = context.createGain()
    gainNode.gain.value = playbackGain
    source.connect(gainNode)
    gainNode.connect(context.destination)
    entries.set(element, { context, source, gain: gainNode })
    void context.resume().catch(() => {})
    return true
  } catch {
    return false
  }
}

export function releaseRemoteAudioGain(element: HTMLAudioElement) {
  const entry = entries.get(element)
  if (!entry) return
  entry.source.disconnect()
  entry.gain.disconnect()
  void entry.context.close().catch(() => {})
  entries.delete(element)
}
