import { runNativeUtilityHost } from './runtime-host'

void runNativeUtilityHost('hotkey').catch(() => process.exit(1))
