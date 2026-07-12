import { runNativeUtilityHost } from './runtime-host'

void runNativeUtilityHost('overlay').catch(() => process.exit(1))
