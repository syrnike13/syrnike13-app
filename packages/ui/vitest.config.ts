import path from 'node:path'
import { fileURLToPath } from 'node:url'

import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [viteReact()],
  resolve: {
    alias: {
      '#': path.resolve(root, 'src'),
      '@syrnike13/ui': path.resolve(root, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    setupFiles: ['./src/test/setup.ts'],
  },
})
