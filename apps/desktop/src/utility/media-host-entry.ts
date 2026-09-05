import { runMediaUtilityHost } from './media-host'
import { failureFromUnknown } from '../main/media-runtime/contract'

void runMediaUtilityHost().catch((cause: unknown) => {
  const failure = failureFromUnknown(cause, 'utility_process')
  process.stderr.write(
    `MEDIA_UTILITY_FAILURE ${JSON.stringify(failure)}\n`,
    () => process.exit(1),
  )
})
