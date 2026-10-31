import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@syrnike13/api-types/effect-schema': path.resolve(root, '../api-types/src/effect-schema.ts'),
      '@syrnike13/api-types/gateway-schema': path.resolve(root, '../api-types/src/gateway-schema.ts'),
      '@syrnike13/api-types': path.resolve(root, '../api-types/src/index.ts'),
    },
  },
})
