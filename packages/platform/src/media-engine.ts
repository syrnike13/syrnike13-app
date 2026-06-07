export type MediaEngineRuntimeStatus =
  | 'running'
  | 'starting'
  | 'not-running'
  | 'unsupported-platform'
  | 'error'

export type MediaEnginePingResult = {
  version: string
  engine: string
  livekit: boolean
}

export type MediaEngineRoomConnectParams = {
  url: string
  token: string
}

export type MediaEngineRoomConnectResult = {
  roomName: string
  sid: string
}

export type MediaEngineReadyEvent = {
  version: string
  engine: string
  pipe: string
}

export type MediaEngineScreenStartParams = {
  sourceId: string
  width: number
  height: number
  fps: number
  maxBitrate?: number
  withAudio?: boolean
}

export type MediaEngineScreenStartResult = {
  activeMethod: string
  audioMode?: string | null
}

export type MediaEngineEvent =
  | {
      event: 'engine.ready'
      params: MediaEngineReadyEvent
    }
  | {
      event: 'engine.crashed'
      params: { message: string }
    }
  | {
      event: 'engine.restarted'
      params: { attempt: number }
    }
  | {
      event: 'room.state'
      params: { connected: boolean }
    }
  | {
      event: 'screen.started'
      params: MediaEngineScreenStartResult
    }
  | {
      event: 'screen.stopped'
      params: Record<string, never>
    }
