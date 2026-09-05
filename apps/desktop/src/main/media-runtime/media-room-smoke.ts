import path from 'node:path'

import { app } from 'electron'

import { MediaRuntimeSupervisor } from './media-runtime-supervisor'
import { ElectronMediaUtilityAdapter } from './media-utility-adapter'
import type { MediaEngineSnapshot, MediaLifecycleEvent } from './contract'

const timeoutMs = 15_000

function requiredEnvironment(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function waitForRoomState(
  subscribe: (listener: (state: string) => void) => () => void,
  current: () => string | undefined,
  expected: string,
) {
  if (current() === expected) return Promise.resolve()
  if (current() === 'failed') {
    return Promise.reject(new Error(`Room failed before reaching ${expected}`))
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Room did not reach ${expected} within ${timeoutMs}ms`))
    }, timeoutMs)
    const unsubscribe = subscribe((state) => {
      if (state === 'failed') {
        clearTimeout(timer)
        unsubscribe()
        reject(new Error(`Room failed before reaching ${expected}`))
        return
      }
      if (state !== expected) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

async function run() {
  const url = requiredEnvironment('LIVEKIT_URL')
  const token = requiredEnvironment('LIVEKIT_PUBLISHER_TOKEN')
  const desktopRoot = requiredEnvironment('SYRNIKE_DESKTOP_ROOT')
  if (!path.isAbsolute(desktopRoot)) {
    throw new Error('SYRNIKE_DESKTOP_ROOT must be absolute')
  }
  const supervisor = new MediaRuntimeSupervisor({
    createAdapter: () => new ElectronMediaUtilityAdapter({
      utilityEntryPath: path.resolve(
        desktopRoot,
        'out',
        'utility',
        'media-host.cjs',
      ),
      nativeModulePath: path.resolve(
        desktopRoot,
        'out',
        'media-native',
        'win32-x64',
        'windows_media.node',
      ),
    }),
  })
  const listeners = new Set<(state: string) => void>()
  let roomState: string | undefined
  const observeState = (state: string) => {
    roomState = state
    for (const listener of listeners) listener(state)
  }
  const observeEvent = (event: MediaLifecycleEvent) => {
    if (event.type === 'roomStateChanged') observeState(event.state)
  }
  const observeSnapshot = (snapshot: MediaEngineSnapshot) => {
    observeState(snapshot.roomState)
  }
  const stopEvent = supervisor.onEvent(observeEvent)
  const stopSnapshot = supervisor.onSnapshot(observeSnapshot)
  const subscribe = (listener: (state: string) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  try {
    await supervisor.start()
    await supervisor.installCredentialLease({
      leaseId: 'media-lab-supervisor-lease',
      serverUrl: url,
      accessToken: token,
    })
    await supervisor.applyDesiredState({
      revision: 1,
      room: {
        roomId: 'native-v2-media-lab',
        participantIdentity: 'native-v2-publisher',
        credentialLeaseId: 'media-lab-supervisor-lease',
      },
      microphone: { state: 'off' },
      camera: { state: 'off' },
      screen: { state: 'off' },
      output: { state: 'off' },
      remoteVideoDemand: [],
    })
    await waitForRoomState(subscribe, () => roomState, 'connected')
    const connected = await supervisor.querySnapshot()
    if (connected.roomState !== 'connected' || connected.acceptedRevision !== 1) {
      throw new Error('Connected production snapshot is incoherent')
    }
    await supervisor.applyDesiredState({
      ...connected.desiredState!,
      revision: 2,
      room: null,
    })
    await waitForRoomState(subscribe, () => roomState, 'off')
    const disconnected = await supervisor.querySnapshot()
    if (disconnected.roomState !== 'off' || disconnected.acceptedRevision !== 2) {
      throw new Error('Disconnected production snapshot is incoherent')
    }
  } finally {
    stopEvent()
    stopSnapshot()
    await supervisor.shutdown()
  }
}

app.whenReady().then(run).then(
  () => {
    process.stdout.write(
      'MEDIA_ROOM_SMOKE {"accepted":true,"connected":true,"disconnected":true}\n',
      () => app.exit(0),
    )
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      () => app.exit(1),
    )
  },
)
