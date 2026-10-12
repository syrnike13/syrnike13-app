import { Schema } from 'effect'

export const MEDIA_TEXTURE_TRANSFER = 'syrnike-desktop:media:texture-transfer'
export const MEDIA_TEXTURE_ACK = 'syrnike-desktop:media:texture-ack'

const dimension = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 8192 }))
const coordinate = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 8192 }))
const opaqueValue = Schema.String.check(Schema.isMaxLength(65_536))
const transferId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/))

export const MediaTextureTransferSchema = Schema.Struct({
  id: transferId,
  transfer: Schema.Struct({
    transfer: opaqueValue,
    syncToken: opaqueValue,
    pixelFormat: Schema.Literal('bgra'),
    codedSize: Schema.Struct({ width: dimension, height: dimension }),
    visibleRect: Schema.Struct({ x: coordinate, y: coordinate, width: dimension, height: dimension }),
    timestamp: Schema.Number.check(Schema.isFinite()),
  }),
  metadata: Schema.Unknown,
})

export const MediaTextureAckSchema = Schema.Struct({
  id: transferId,
  phase: Schema.Literals(['imported', 'released']),
})
