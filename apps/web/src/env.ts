import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { APP_VERSION } from './version.gen'

const url = (fallback: string) =>
  z
    .string()
    .url()
    .optional()
    .transform((value) => value ?? fallback)

export const env = createEnv({
  server: {
    SERVER_URL: z.string().url().optional(),
  },

  clientPrefix: 'VITE_',

  client: {
    VITE_APP_TITLE: z.string().min(1).default('syrnike13'),
    VITE_APP_VERSION: z.string().min(1).default(APP_VERSION),
    VITE_RELEASE_CHANNEL: z.enum(['stable', 'nightly']).default('stable'),
    VITE_API_URL: url('https://syrnike13.ru/api'),
    VITE_WS_URL: z
      .string()
      .optional()
      .transform((value) => value ?? 'wss://syrnike13.ru/ws'),
    VITE_MEDIA_URL: url('https://syrnike13.ru/autumn'),
    VITE_PROXY_URL: url('https://syrnike13.ru/january'),
    VITE_GIFBOX_URL: z
      .string()
      .url()
      .optional()
      .default('https://api.gifbox.me'),
    VITE_HCAPTCHA_SITEKEY: z.string().optional(),
    /** LiveKit-нода для gateway voice join (по умолчанию — первая из `GET /`). */
    VITE_VOICE_NODE: z.string().min(1).optional(),
  },

  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
})
