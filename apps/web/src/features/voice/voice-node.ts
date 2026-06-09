import { env } from '#/env'
import { fetchApiRoot } from '#/lib/api/client'

const FALLBACK_VOICE_NODE = 'worldwide'

type ApiRootFeatures = {
  livekit?: {
    enabled?: boolean
    nodes?: Array<{ name: string }>
  }
}

let cachedNode: string | null = null
let loadPromise: Promise<string> | null = null

function nodeFromRoot(root: unknown) {
  const features = (root as { features?: ApiRootFeatures }).features
  const nodes = features?.livekit?.nodes
  if (!nodes?.length) return FALLBACK_VOICE_NODE
  return nodes[0]?.name || FALLBACK_VOICE_NODE
}

export function resolveVoiceNodeName() {
  if (env.VITE_VOICE_NODE) {
    return Promise.resolve(env.VITE_VOICE_NODE)
  }

  if (cachedNode) {
    return Promise.resolve(cachedNode)
  }

  if (!loadPromise) {
    loadPromise = fetchApiRoot()
      .then((root) => {
        cachedNode = nodeFromRoot(root)
        return cachedNode
      })
      .catch(() => {
        cachedNode = FALLBACK_VOICE_NODE
        return cachedNode
      })
  }

  return loadPromise
}
