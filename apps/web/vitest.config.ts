import path from 'node:path'
import { fileURLToPath } from 'node:url'

import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))
/** Пакет помечен `type:module`, но `main` указывает на CJS `dist/index.js`. */
const squircleReactEntry = path.resolve(
  root,
  'node_modules/@squircle-js/react/dist/index.mjs',
)

export default defineConfig({
  plugins: [viteReact()],
  resolve: {
    alias: {
      '#': path.resolve(root, 'src'),
      '@syrnike13/activity-sdk/protocol': path.resolve(
        root,
        '../../packages/activity-sdk/src/protocol.ts',
      ),
      '@syrnike13/api-types/effect-schema': path.resolve(
        root,
        '../../packages/api-types/src/effect-schema.ts',
      ),
      '@syrnike13/api-types/gateway-schema': path.resolve(
        root,
        '../../packages/api-types/src/gateway-schema.ts',
      ),
      '@syrnike13/api-types': path.resolve(root, '../../packages/api-types/src/index.ts'),
      '@syrnike13/platform': path.resolve(root, '../../packages/platform/src/index.ts'),
      '@syrnike13/ui': path.resolve(root, '../../packages/ui/src'),
      '@squircle-js/react': squircleReactEntry,
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    setupFiles: ['./src/test/setup.ts'],
  },
})
