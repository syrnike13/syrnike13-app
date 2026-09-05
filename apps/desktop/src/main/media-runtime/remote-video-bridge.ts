import { TextureLeaseBridge, type TextureBridgeDriver, type TextureReference } from './texture-lease-bridge'
import { Option, Schema } from 'effect'

const integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const positive = integer.check(Schema.isGreaterThan(0))
export class NativeVideoFrame extends Schema.Class<NativeVideoFrame>('NativeVideoFrame')({
  version: Schema.Literal(1),
  generation: positive,
  sequence: positive,
  slot: integer.check(Schema.isLessThan(4)),
  width: positive.check(Schema.isLessThanOrEqualTo(3840)),
  height: positive.check(Schema.isLessThanOrEqualTo(2160)),
  timestamp: integer,
  ingressUs: integer,
  publicationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  participantIdentity: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  handle: positive,
}) {}

export type VideoLeaseKey = Pick<NativeVideoFrame, 'generation' | 'sequence' | 'slot'>
export type RendererVideoFrame = Omit<NativeVideoFrame, 'handle'> & { readonly hostEpoch: number }
export class RemoteVideoBridge<Texture extends TextureReference> extends TextureLeaseBridge<NativeVideoFrame, Texture> {
  constructor(driver: TextureBridgeDriver<NativeVideoFrame, Texture>) {
    super(driver, value => Option.getOrUndefined(
      Schema.decodeUnknownOption(NativeVideoFrame, { onExcessProperty: 'error' })(value)), 4)
  }
}
