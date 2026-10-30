const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')

const path = require('node:path')

const config = getDefaultConfig(__dirname)

// Expo watches the whole monorepo; crawling services/ and build output makes
// Metro hang on startup. Watch only what the app imports.
const workspaceRoot = path.resolve(__dirname, '../..')
config.watchFolders = [
  path.join(workspaceRoot, 'node_modules'),
  path.join(workspaceRoot, 'packages/ui'),
  path.join(workspaceRoot, 'packages/ui-native'),
  path.join(workspaceRoot, 'packages/platform'),
  path.join(workspaceRoot, 'packages/api-types'),
]

// Shared workspace packages are bundled from source, not from their dist builds.
const SOURCE_ENTRIES = {
  '@syrnike13/platform': path.join(workspaceRoot, 'packages/platform/src/index.ts'),
}
config.resolver.blockList = [/[\\/]android[\\/](app[\\/])?(build|\.cxx|\.gradle)[\\/].*/]

// Shared web packages keep their own React in node_modules; a second copy
// breaks hooks, so React and React Native always come from this app.
const appOrigin = path.join(__dirname, 'package.json')
const SINGLETONS = /^(react|react-native)(\/|$)/

const resolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = resolveRequest ?? context.resolveRequest
  if (SOURCE_ENTRIES[moduleName]) {
    return { type: 'sourceFile', filePath: SOURCE_ENTRIES[moduleName] }
  }
  if (SINGLETONS.test(moduleName)) {
    return resolve({ ...context, originModulePath: appOrigin }, moduleName, platform)
  }
  // Shared packages use TypeScript ESM imports (`./types.js` -> `types.ts`),
  // which Vite resolves and Metro does not.
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, moduleName.slice(0, -3), platform)
    } catch {
      // Fall through to a real .js file.
    }
  }
  return resolve(context, moduleName, platform)
}

module.exports = withUniwindConfig(config, {
  cssEntryFile: './src/global.css',
  dtsFile: './src/uniwind-types.d.ts',
})
