export function mergeSpeakingUserIds({
  remoteUserIds,
  selfUserId,
  selfSpeaking,
}: {
  remoteUserIds: ReadonlySet<string>
  selfUserId: string | null
  selfSpeaking: boolean
}) {
  const next = new Set(remoteUserIds)
  if (selfUserId && selfSpeaking) {
    next.add(selfUserId)
  }
  return next
}
