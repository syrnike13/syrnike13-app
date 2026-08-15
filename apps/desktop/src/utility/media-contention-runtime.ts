import { Effect } from 'effect'

import { NATIVE_RUNTIME_CONTRACT_VERSION } from '../main/native-runtime/contract'
import { NativeRuntimeSupervisor } from '../main/native-runtime/runtime-supervisor'
import { NativeSharedTextureBridge } from '../main/native-video/shared-texture-bridge'

export {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  NativeRuntimeSupervisor,
  NativeSharedTextureBridge,
}

type RendererLeaseReleaseCommand = Parameters<
  NativeRuntimeSupervisor['releaseRendererLeaseEffect']
>[0]

export function runRendererLeaseRelease(
  supervisor: NativeRuntimeSupervisor,
  command: RendererLeaseReleaseCommand,
) {
  return Effect.runPromise(
    supervisor.releaseRendererLeaseEffect(command).pipe(Effect.asVoid),
  )
}
