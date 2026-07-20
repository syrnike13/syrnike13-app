import { stageScreenMediaUserId } from '#/features/voice/voice-stage-subscription'

type VoiceStageViewSessionBase = Readonly<{
  id: string
  stageItemId: string
  label: string
}>

export type VoiceStageViewSession =
  | (VoiceStageViewSessionBase & Readonly<{ kind: 'stream' }>)
  | (VoiceStageViewSessionBase &
      Readonly<{
        kind: 'activity'
        channelId: string
        instanceId: string
      }>)

export function buildVoiceStageViewSessions({
  viewedRemoteScreenIds,
  screenDisplayName,
  activity,
}: {
  viewedRemoteScreenIds: readonly string[]
  screenDisplayName: (userId: string) => string
  activity?: Readonly<{
    stageItemId: string
    instanceId: string
    channelId: string
    label: string
    joined: boolean
  }> | null
}): VoiceStageViewSession[] {
  const sessions: VoiceStageViewSession[] = []
  const seenScreenIds = new Set<string>()

  for (const mediaId of viewedRemoteScreenIds) {
    if (seenScreenIds.has(mediaId)) continue
    const userId = stageScreenMediaUserId(mediaId)
    if (!userId) continue
    seenScreenIds.add(mediaId)
    sessions.push({
      id: `stream:${mediaId}`,
      stageItemId: mediaId,
      kind: 'stream',
      label: screenDisplayName(userId),
    })
  }

  if (activity?.joined) {
    sessions.push({
      id: `activity:${activity.instanceId}`,
      stageItemId: activity.stageItemId,
      kind: 'activity',
      label: activity.label,
      channelId: activity.channelId,
      instanceId: activity.instanceId,
    })
  }

  return sessions
}

export function voiceStageViewSessionExitLabel(
  session: VoiceStageViewSession,
) {
  return session.kind === 'activity'
    ? `Выйти из активности — ${session.label}`
    : `Прекратить просмотр — ${session.label}`
}
