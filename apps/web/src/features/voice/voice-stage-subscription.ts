import type { StageMediaItem } from '#/features/voice/voice-stage-media'

type StageScreenPublication = {
  setSubscribed?: (subscribed: boolean) => void
}

export type StageMediaSubscriptionAction = 'none' | 'stop-local-screen'

export function setStageScreenSubscription(
  item: StageMediaItem<unknown, StageScreenPublication> | null | undefined,
  subscribed: boolean,
): StageMediaSubscriptionAction {
  if (!item || item.kind !== 'screen') return 'none'

  if (item.isLocal) {
    return subscribed ? 'none' : 'stop-local-screen'
  }

  item.publication?.setSubscribed?.(subscribed)
  return 'none'
}
