import { runNativeUtilityHost } from './runtime-host'

void runNativeUtilityHost('hooks').catch(() => process.exit(1))
