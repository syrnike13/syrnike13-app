// Installed only by the isolated product harness. Clones retain the same GPU
// resources even when normal app consumers close their original frames.
exports.installRendererReleaseProbe = function installRendererReleaseProbe() {
  window.rendererReleaseProbe?.dispose()
  const held = []
  let active = false
  let overflow = false
  const receive = event => {
    if (!active || event.source !== window || event.origin !== location.origin ||
        event.data?.type !== 'syrnike-native-video-frame' ||
        !event.data.metadata?.local || event.data.metadata.source !== 'screen' ||
        !(event.data.frame instanceof VideoFrame)) return
    if (held.length === 2) {
      overflow = true
      return
    }
    held.push(event.data.frame.clone())
  }
  const release = () => {
    active = false
    for (const frame of held.splice(0)) frame.close()
  }
  window.addEventListener('message', receive, true)
  window.rendererReleaseProbe = {
    start() {
      if (active || held.length) throw new Error('renderer_release_probe_already_active')
      overflow = false
      active = true
    },
    snapshot() { return { active, held: held.length, openFrames: held.filter(frame => frame.displayWidth > 0).length, overflow } },
    release,
    dispose() {
      release()
      window.removeEventListener('message', receive, true)
      delete window.rendererReleaseProbe
    },
  }
}
