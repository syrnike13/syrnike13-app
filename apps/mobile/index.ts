import { registerGlobals } from './src/voice/livekit'

// WebRTC globals for livekit-client; must run before any LiveKit import is used.
registerGlobals()

// Routes live in src/app (Expo Router).
import 'expo-router/entry'
