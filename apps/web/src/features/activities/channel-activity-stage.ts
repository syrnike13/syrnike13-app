export const CHANNEL_ACTIVITY_STAGE_ITEM_ID_PREFIX = 'channel-activity:'

export function channelActivityStageItemId(instanceId: string) {
  return `${CHANNEL_ACTIVITY_STAGE_ITEM_ID_PREFIX}${instanceId}`
}

export function isChannelActivityStageItemId(mediaId: string | null) {
  return mediaId?.startsWith(CHANNEL_ACTIVITY_STAGE_ITEM_ID_PREFIX) ?? false
}
