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
    VITE_APP_TITLE: z.string().min(1).default('syrnike13 Admin'),
    VITE_APP_VERSION: z.string().min(1).default(APP_VERSION),
    VITE_RELEASE_CHANNEL: z.enum(['stable', 'nightly']).default('stable'),
    VITE_API_URL: url('https://syrnike13.ru/api'),
    VITE_ADMIN_WEB_URL: url('https://admin.syrnike13.ru'),
  },
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
})
