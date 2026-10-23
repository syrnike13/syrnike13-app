import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { getDefaultThemeCss } from '../../packages/ui/src/tokens/default-css'

const landingRoot = path.dirname(fileURLToPath(import.meta.url))
const uiEntry = path.resolve(landingRoot, '../../packages/ui/src')

export default defineConfig({
  resolve: {
    alias: {
      '@syrnike13/ui': uiEntry,
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 3000,
    host: true,
    strictPort: true,
  },
  preview: {
    port: 3000,
    host: true,
    strictPort: true,
  },
  plugins: [
    tailwindcss(),
    {
      name: 'syrnike13-landing-theme',
      transformIndexHtml() {
        return [
          {
            tag: 'style',
            attrs: { 'data-slot': 'default-theme' },
            children: getDefaultThemeCss(),
            injectTo: 'head-prepend',
          },
        ]
      },
    },
    viteReact(),
  ],
})
