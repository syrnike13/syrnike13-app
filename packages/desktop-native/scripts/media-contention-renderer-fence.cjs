function releaseAfterRendererFence(
  importedSharedTexture,
  holdMs,
  schedule = setTimeout,
) {
  const release = () => importedSharedTexture.release()
  if (Number.isFinite(holdMs) && holdMs > 0) {
    schedule(release, holdMs)
    return
  }
  release()
}

module.exports = { releaseAfterRendererFence }
