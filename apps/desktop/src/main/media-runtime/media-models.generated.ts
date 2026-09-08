// Generated from protocol/media-lifecycle.json. Do not edit.
import { Schema } from 'effect'

const identifier = Schema.String.check(
  Schema.isMinLength(1), Schema.isMaxLength(256),
  Schema.isPattern(/^[\x21-\x7e]+$/),
)

export const AudioMixSettingSchema = Schema.Struct({
  identity: identifier,
  volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  muted: Schema.Boolean,
})
export type AudioMixSetting = typeof AudioMixSettingSchema.Type

export const MicrophoneIntentSchema = Schema.Union([Schema.Struct({ state: Schema.Literal('off') }), Schema.Struct({
  state: Schema.Literals(["warm","on"]),
  deviceId: Schema.Union([identifier, Schema.Null]),
  muted: Schema.Boolean,
  pushToTalk: Schema.Boolean,
  pushToTalkHeld: Schema.Boolean,
  bypassSystemProcessing: Schema.Boolean,
  automaticGainControl: Schema.Boolean,
  noiseSuppression: Schema.Boolean,
  echoCancellation: Schema.Boolean,
  inputVolume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
  gateEnabled: Schema.Boolean,
  gateThresholdDb: Schema.Finite.check(Schema.isBetween({ minimum: -100, maximum: 0 })),
  gateAutoThreshold: Schema.Boolean,
  meterDemand: Schema.Boolean,
  retryRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9007199254740991 })),
})])
export type MicrophoneIntent = typeof MicrophoneIntentSchema.Type

export const CameraIntentSchema = Schema.Union([Schema.Struct({ state: Schema.Literal('off') }), Schema.Struct({
  state: Schema.Literals(["on"]),
  deviceId: Schema.Union([identifier, Schema.Null]),
  profile: Schema.Literals(["hd720p30","hd1080p30"]),
  publication: Schema.Boolean,
  previewRendererId: Schema.Union([identifier, Schema.Null]),
  retryRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9007199254740991 })),
})])
export type CameraIntent = typeof CameraIntentSchema.Type

export const ScreenIntentSchema = Schema.Union([Schema.Struct({ state: Schema.Literal('off') }), Schema.Struct({
  state: Schema.Literals(["on"]),
  sourceId: identifier,
  width: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 7680 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 4320 })),
  fps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 240 })),
  bitrate: Schema.Int.check(Schema.isBetween({ minimum: 32000, maximum: 100000000 })),
  audioMode: Schema.Literals(["none","system","process"]),
  audioBitrate: Schema.Int.check(Schema.isBetween({ minimum: 6000, maximum: 512000 })),
  previewRendererId: Schema.Union([identifier, Schema.Null]),
  retryRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9007199254740991 })),
  audioRetryRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9007199254740991 })),
})])
export type ScreenIntent = typeof ScreenIntentSchema.Type

export const OutputIntentSchema = Schema.Union([Schema.Struct({ state: Schema.Literal('off') }), Schema.Struct({
  state: Schema.Literals(["on"]),
  deviceId: Schema.Union([identifier, Schema.Null]),
  deafened: Schema.Boolean,
  volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  users: Schema.Array(AudioMixSettingSchema).check(Schema.isMaxLength(1024)),
  streams: Schema.Array(AudioMixSettingSchema).check(Schema.isMaxLength(1024)),
  retryRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9007199254740991 })),
})])
export type OutputIntent = typeof OutputIntentSchema.Type
