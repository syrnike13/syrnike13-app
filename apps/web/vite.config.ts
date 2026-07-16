import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const webRoot = path.dirname(fileURLToPath(import.meta.url))
const apiTypesEntry = path.resolve(webRoot, '../../packages/api-types/src/index.ts')
const platformEntry = path.resolve(webRoot, '../../packages/platform/src/index.ts')
/** Пакет помечен `type:module`, но `main` указывает на CJS `dist/index.js`. */
const squircleReactEntry = path.resolve(
  webRoot,
  'node_modules/@squircle-js/react/dist/index.mjs',
)

const config = defineConfig({
  envDir: path.resolve(webRoot, 'env'),
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
    /** Workspace TS package — bundle in SSR, do not treat as external Node dep. */
    noExternal: [
      '@syrnike13/api-types',
      '@syrnike13/platform',
      '@squircle-js/react',
    ],
  },
  resolve: {
    alias: {
      '@syrnike13/api-types': apiTypesEntry,
      '@syrnike13/platform': platformEntry,
      '@squircle-js/react': squircleReactEntry,
    },
    tsconfigPaths: true,
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      '@remixicon/react',
      'iconoir-react',
      'iconoir-react/solid',
      '@iconify/react',
      '@squircle-js/react',
    ],
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
