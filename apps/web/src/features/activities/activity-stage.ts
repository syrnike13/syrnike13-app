export const ACTIVITY_STAGE_ITEM_ID_PREFIX = 'activity:'

/** Voice Stage item id of a running Activity Instance. */
export function activityStageItemId(instanceId: string) {
  return `${ACTIVITY_STAGE_ITEM_ID_PREFIX}${instanceId}`
}

export function isActivityStageItemId(mediaId: string | null) {
  return mediaId?.startsWith(ACTIVITY_STAGE_ITEM_ID_PREFIX) ?? false
}
