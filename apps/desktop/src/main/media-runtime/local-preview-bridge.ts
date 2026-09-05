import { Option, Schema } from 'effect'
import { TextureLeaseBridge, type TextureBridgeDriver, type TextureReference } from './texture-lease-bridge'

const integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const positive = integer.check(Schema.isGreaterThan(0))
export class NativePreviewFrame extends Schema.Class<NativePreviewFrame>('NativePreviewFrame')({
  version: Schema.Literal(1),
  kind: Schema.Literal('local-preview'),
  generation: positive,
  revision: positive,
  sequence: positive,
  slot: integer.check(Schema.isLessThan(2)),
  publicationGeneration: positive,
  sourceGeneration: positive,
  width: positive.check(Schema.isLessThanOrEqualTo(1280)),
  height: positive.check(Schema.isLessThanOrEqualTo(720)),
  timestamp: positive,
  handle: positive,
}) {}

export class LocalPreviewBridge<Texture extends TextureReference> extends TextureLeaseBridge<NativePreviewFrame, Texture> {
  constructor(driver: TextureBridgeDriver<NativePreviewFrame, Texture>) {
    super(driver, value => Option.getOrUndefined(
      Schema.decodeUnknownOption(NativePreviewFrame, { onExcessProperty: 'error' })(value)), 2)
  }
}
