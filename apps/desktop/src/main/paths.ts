import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app } from 'electron'

const mainDir = path.dirname(fileURLToPath(import.meta.url))

/** Корень `apps/web/dist` в dev и в собранном .app/.exe. */
export function resolveWebDistRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web-dist')
  }
  return path.resolve(mainDir, '../../../web/dist')
}

export function resolvePreloadScript() {
  return path.join(mainDir, '../preload/index.cjs')
}
