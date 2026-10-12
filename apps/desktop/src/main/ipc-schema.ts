import { Option, Schema } from 'effect'

export function decodeIpcInput<
  InputSchema extends Schema.ConstraintDecoder<unknown, never>,
>(
  channel: string,
  label: string,
  schema: InputSchema,
  value: unknown,
): InputSchema['Type'] {
  const decoded = Schema.decodeUnknownOption(schema)(value)
  if (Option.isNone(decoded)) {
    throw new TypeError(`Invalid IPC input for ${channel}: ${label}`)
  }
  return decoded.value
}
