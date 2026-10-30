import { registerGlobals } from '@livekit/react-native'
import { registerRootComponent } from 'expo'

import { App } from './src/App'

// WebRTC globals for livekit-client; must run before any LiveKit import is used.
registerGlobals()

registerRootComponent(App)
