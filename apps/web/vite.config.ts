import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const webRoot = path.dirname(fileURLToPath(import.meta.url))
const apiTypesEntry = path.resolve(webRoot, '../../packages/api-types/src/index.ts')
const platformEntry = path.resolve(webRoot, '../../packages/platform/src/index.ts')

const config = defineConfig({
  server: {
    port: 3000,
    /** IPv4 + IPv6: иначе Electron (127.0.0.1) и браузер (localhost) попадают на разные сокеты. */
    host: true,
    strictPort: true,
  },
  preview: {
    port: 3000,
    host: true,
    strictPort: true,
  },
  ssr: {
    /** ESM entry without `.js` extensions — only load in the browser. */
    external: ['livekit-rnnoise-processor'],
    /** Workspace TS package — bundle in SSR, do not treat as external Node dep. */
    noExternal: ['@syrnike13/api-types', '@syrnike13/platform'],
  },
  resolve: {
    alias: {
      '@syrnike13/api-types': apiTypesEntry,
      '@syrnike13/platform': platformEntry,
    },
    tsconfigPaths: true,
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['@syrnike13/api-types', '@syrnike13/platform'],
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
      },
    }),
    viteReact(),
  ],
})

export default config
