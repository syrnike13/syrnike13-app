import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const adminRoot = path.dirname(fileURLToPath(import.meta.url))
const apiTypesEntry = path.resolve(
  adminRoot,
  '../../packages/api-types/src/index.ts',
)

const config = defineConfig({
  envDir: path.resolve(adminRoot, 'env'),
  server: {
    port: 3001,
    host: true,
    strictPort: true,
  },
  preview: {
    port: 3001,
    host: true,
    strictPort: true,
  },
  ssr: {
    noExternal: ['@syrnike13/api-types'],
  },
  resolve: {
    alias: {
      '@syrnike13/api-types': apiTypesEntry,
    },
    tsconfigPaths: true,
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['@remixicon/react'],
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
