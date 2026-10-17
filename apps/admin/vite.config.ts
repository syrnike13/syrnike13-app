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
const apiTypesEffectSchemaEntry = path.resolve(
  adminRoot,
  '../../packages/api-types/src/effect-schema.ts',
)
const uiEntry = path.resolve(adminRoot, '../../packages/ui/src')

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
    noExternal: ['@syrnike13/api-types', '@syrnike13/ui'],
  },
  resolve: {
    alias: {
      '@syrnike13/api-types/effect-schema': apiTypesEffectSchemaEntry,
      '@syrnike13/api-types': apiTypesEntry,
      '@syrnike13/ui': uiEntry,
    },
    tsconfigPaths: true,
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    exclude: ['@syrnike13/ui'],
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
