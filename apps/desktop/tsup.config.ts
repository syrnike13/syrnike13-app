import { defineConfig } from 'tsup'

const WEB_DEV_URL = process.env.SYRNIKE_WEB_DEV_URL ?? 'http://127.0.0.1:3000'

export default defineConfig([
  {
    entry: ['src/main/index.ts'],
    outDir: 'out/main',
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    clean: true,
    splitting: false,
    external: ['electron'],
    noExternal: ['@syrnike13/platform'],
    define: {
      __WEB_DEV_URL__: JSON.stringify(WEB_DEV_URL),
    },
  },
  {
    entry: ['src/preload/index.ts'],
    outDir: 'out/preload',
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    splitting: false,
    external: ['electron'],
    noExternal: ['@syrnike13/platform'],
  },
])
