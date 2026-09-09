// Install through Playwright's page.evaluate before joining the voice channel.
// Keep metadata weakly associated with frames; the probe must never own a frame.
exports.installVideoDrawProbe = async function installVideoDrawProbe() {
  window.nativeVideoDrawProbe?.dispose()
  const frames = new WeakMap()
  const tracks = new Map()
  const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage
  let runtimeEpoch = (await window.syrnikeDesktop.media.getRuntimeState()).hostEpoch
  let overflow = false

  const unsubscribe = window.syrnikeDesktop.media.onRuntimeState(state => {
    if (state.hostEpoch !== runtimeEpoch || state.status !== 'ready') {
      runtimeEpoch = state.hostEpoch
      tracks.clear()
    }
  })

  const receiveFrame = event => {
    if (event.source !== window || event.origin !== window.location.origin ||
        event.data?.type !== 'syrnike-native-video-frame' ||
        !(event.data.frame instanceof VideoFrame)) return
    const metadata = event.data.metadata
    if (!metadata || metadata.runtimeEpoch !== runtimeEpoch ||
        !['camera', 'screen'].includes(metadata.source) ||
        typeof metadata.local !== 'boolean') return
    frames.set(event.data.frame, {
      key: `${metadata.sessionId}:${metadata.generation}:${metadata.trackId}`,
      epoch: metadata.runtimeEpoch, local: metadata.local, source: metadata.source,
    })
  }
  window.addEventListener('message', receiveFrame)

  function drawImage(frame, ...arguments_) {
    const result = originalDrawImage.call(this, frame, ...arguments_)
    const metadata = frames.get(frame)
    if (!metadata || metadata.epoch !== runtimeEpoch) return result
    let track = tracks.get(metadata.key)
    if (!track) {
      if (tracks.size >= 64) {
        overflow = true
        return result
      }
      track = { local: metadata.local, source: metadata.source, framesDrawn: 0,
        lastDrawAt: 0, sourceWidth: 0, sourceHeight: 0 }
      tracks.set(metadata.key, track)
    }
    ++track.framesDrawn
    track.lastDrawAt = performance.now()
    track.sourceWidth = frame.displayWidth
    track.sourceHeight = frame.displayHeight
    return result
  }
  CanvasRenderingContext2D.prototype.drawImage = drawImage

  window.nativeVideoDrawProbe = {
    snapshot() {
      if (overflow) throw new Error('video_draw_probe_capacity')
      const now = performance.now()
      return [...tracks.values()].map(track => ({
        local: track.local, source: track.source,
        metrics: { framesDrawn: track.framesDrawn,
          lastDrawAgeMs: now - track.lastDrawAt,
          sourceWidth: track.sourceWidth, sourceHeight: track.sourceHeight },
      }))
    },
    dispose() {
      unsubscribe()
      window.removeEventListener('message', receiveFrame)
      if (CanvasRenderingContext2D.prototype.drawImage === drawImage) {
        CanvasRenderingContext2D.prototype.drawImage = originalDrawImage
      }
      tracks.clear()
      delete window.nativeVideoDrawProbe
    },
  }
}
