// LiveKit in the browser: the browser's own WebRTC, so there are no globals to
// install and no native audio session to manage.
export {
  RoomContext,
  useIsSpeaking,
  useParticipants,
  useSpeakingParticipants,
  useTracks,
  type TrackReference,
} from '@livekit/components-react'

export function registerGlobals() {}

export const AudioSession = {
  async startAudioSession() {},
  async stopAudioSession() {},
}
