import { runNativeUtilityHost } from './runtime-host'

void runNativeUtilityHost('media').catch(() => process.exit(1))
