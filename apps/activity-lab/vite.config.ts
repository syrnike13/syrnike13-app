import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

export default defineConfig({
  // Served from `/_activities/lab/` behind the activity proxy: every URL is relative.
  base: './',
  resolve: {
    alias: {
      // Use SDK sources so the lab does not need a prebuilt `dist`.
      '@syrnike13/activity-sdk': fileURLToPath(
        new URL('../../packages/activity-sdk/src/index.ts', import.meta.url),
      ),
    },
  },
  server: { port: 3002, host: true, strictPort: true },
  preview: { port: 3002, host: true, strictPort: true },
  build: { outDir: 'dist' },
})
