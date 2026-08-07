import { Effect } from 'effect'

import { env } from '#/env'
import { fetchApiRoot, fetchApiRootEffect } from '#/lib/api/client'

const FALLBACK_VOICE_NODE = 'worldwide'

function nodeFromRoot(root: Awaited<ReturnType<typeof fetchApiRoot>>) {
  const nodes = root.features.livekit.nodes
  if (nodes.length === 0) return FALLBACK_VOICE_NODE
  return nodes[0]?.name || FALLBACK_VOICE_NODE
}

export const resolveVoiceNodeNameEffect = Effect.runSync(
  Effect.cached(
    env.VITE_VOICE_NODE
      ? Effect.succeed(env.VITE_VOICE_NODE)
      : fetchApiRootEffect().pipe(
          Effect.map(nodeFromRoot),
          Effect.catch(() => Effect.succeed(FALLBACK_VOICE_NODE)),
        ),
  ),
)
