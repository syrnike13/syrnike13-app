import { Option, Schema } from 'effect'

const NodeAttributesSchema = Schema.Record(Schema.String, Schema.Unknown)

export function readStringNodeAttribute(
  attributes: unknown,
  key: string,
): string | undefined {
  const decodedAttributes = Schema.decodeUnknownOption(NodeAttributesSchema)(
    attributes,
  )
  if (Option.isNone(decodedAttributes)) return undefined
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.String)(decodedAttributes.value[key]),
  )
}
