import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/main/media-runtime/remote-video-bridge.ts', 'src/main/media-runtime/local-preview-bridge.ts'],
  outDir: 'out/video-lab', format: ['cjs'], platform: 'node', target: 'node20',
  external: ['electron'], noExternal: ['effect'], clean: true,
})
