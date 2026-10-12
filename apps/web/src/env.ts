import { createEnv } from '@t3-oss/env-core'
import { Effect, Schema } from 'effect'

import { APP_VERSION } from './version.gen'

const nonEmptyString = Schema.String.check(Schema.isMinLength(1))
const urlString = Schema.String.check(
  Schema.makeFilter((value) => URL.canParse(value), {
    message: 'Expected a valid URL',
  }),
)

const optional = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
) =>
  Schema.toStandardSchemaV1(Schema.optional(schema))

const withDefault = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  fallback: S['Encoded'],
) =>
  Schema.toStandardSchemaV1(
    Schema.withDecodingDefault(Effect.succeed(fallback))(schema),
  )

const url = (fallback: string) => withDefault(urlString, fallback)

export const env = createEnv({
  server: {
    SERVER_URL: optional(urlString),
  },

  clientPrefix: 'VITE_',

  client: {
    VITE_APP_TITLE: withDefault(nonEmptyString, 'syrnike13'),
    VITE_APP_VERSION: withDefault(nonEmptyString, APP_VERSION),
    VITE_RELEASE_CHANNEL: withDefault(
      Schema.Literals(['stable', 'nightly']),
      'stable',
    ),
    VITE_API_URL: url('https://syrnike13.ru/api'),
    VITE_WS_URL: withDefault(Schema.String, 'wss://syrnike13.ru/ws'),
    VITE_MEDIA_URL: url('https://syrnike13.ru/autumn'),
    VITE_PROXY_URL: url('https://syrnike13.ru/january'),
    VITE_GIFBOX_URL: url('https://api.gifbox.me'),
    VITE_HCAPTCHA_SITEKEY: optional(Schema.String),
    /** LiveKit-нода для gateway voice join (по умолчанию — первая из `GET /`). */
    VITE_VOICE_NODE: optional(nonEmptyString),
  },

  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
})
