const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')

const path = require('node:path')

const config = getDefaultConfig(__dirname)

// Shared web packages keep their own React in node_modules; a second copy
// breaks hooks, so React and React Native always come from this app.
const appOrigin = path.join(__dirname, 'package.json')
const SINGLETONS = /^(react|react-native)(\/|$)/

const resolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = resolveRequest ?? context.resolveRequest
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
