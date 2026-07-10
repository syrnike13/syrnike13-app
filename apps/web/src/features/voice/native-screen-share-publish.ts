export type NativeScreenShareSession = {
  publicationId?: string
  nativeParticipantIdentity?: string | null
  stop: () => Promise<void>
}
