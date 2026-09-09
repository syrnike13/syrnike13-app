import { createServer } from 'node:http'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
import { Effect, Schema } from 'effect'
import { createInitialVoiceMediaDesiredState, type VoiceMediaDesiredState } from '@syrnike13/platform'
import { createNativeRtcEngineAdapter, registerNativeMediaRuntimeIpc, flushNativeMediaDiagnosticsEffect } from '../native-media-engine'
import { registerDisplayMediaIpc, installMediaPermissions } from '../media-permissions'
import { disposeWithinDesktopShutdownBudget } from '../shutdown-budget'
import { electronFrameTransfers } from './electron-frame-transfers'

const environment = Schema.decodeUnknownSync(Schema.Struct({
  LIVEKIT_URL: Schema.String,
  LIVEKIT_PUBLISHER_TOKEN: Schema.String,
  MEDIA_PRODUCT_PROFILE: Schema.String,
  MEDIA_PRODUCT_REPORT: Schema.String,
  MEDIA_PRODUCT_RENDERER_FAULTS: Schema.optional(Schema.Literal('1')),
}))(process.env)
app.setPath('userData', environment.MEDIA_PRODUCT_PROFILE)

const rendererHtml = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Native product transport check</title><body><h1>Native product transport check</h1>
<canvas id="screen" width="960" height="540"></canvas><canvas id="camera" width="640" height="360"></canvas>
<canvas id="remote" width="320" height="180"></canvas>
<script>
window.fixture = { ready: false, screen: 0, camera: 0, remote: 0, failures: 0, epoch: 0, states: 0,
  remoteAlias: '', holdScreen: false, heldScreens: 0 };
const heldScreens = [];
window.releaseHeldScreens = () => {
  window.fixture.holdScreen = false;
  for (const frame of heldScreens.splice(0)) frame.close();
  window.fixture.heldScreens = 0;
};
window.addEventListener('message', event => {
  if (event.source !== window) return;
  if (event.data?.type === 'syrnike-native-video-publication-available') {
    const { sessionId, generation, trackId } = event.data.metadata;
    window.syrnikeDesktop.media.setRemoteVideoDemand(sessionId, generation, trackId, true)
      .catch(() => { window.fixture.failures += 1; });
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(trackId)).then(hash => {
      window.fixture.remoteAlias = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('').slice(0, 12);
    }).catch(() => { window.fixture.failures += 1; });
    return;
  }
  if (event.data?.type !== 'syrnike-native-video-frame') return;
  const { frame, metadata } = event.data;
  let held = false;
  try {
    if (!(frame instanceof VideoFrame)) throw Error('Missing VideoFrame');
    if (metadata.runtimeEpoch < window.fixture.epoch) throw Error('Stale runtime frame');
    window.fixture.epoch = metadata.runtimeEpoch;
    const kind = metadata.local ? metadata.source : 'remote';
    if (metadata.local && kind === 'screen' && window.fixture.holdScreen) {
      if (heldScreens.length >= 2) throw Error('Screen hold capacity exceeded');
      heldScreens.push(frame);
      window.fixture.heldScreens = heldScreens.length;
      held = true;
      return;
    }
    const canvas = document.getElementById(kind);
    canvas.getContext('2d').drawImage(frame, 0, 0, canvas.width, canvas.height);
    window.fixture[kind] += 1;
  } catch { window.fixture.failures += 1; }
  finally { if (!held) frame?.close(); }
});
window.syrnikeDesktop.media.onRuntimeState(() => { window.fixture.states += 1; });
window.syrnikeDesktop.media.replayRemoteVideoPublications().then(() => {
  window.fixture.ready = true;
});
</script></body></html>`

const RendererMetrics = Schema.Struct({
  ready: Schema.Boolean, screen: Schema.Natural, camera: Schema.Natural, remote: Schema.Natural,
  failures: Schema.Natural, epoch: Schema.Natural, states: Schema.Natural,
  remoteAlias: Schema.String, holdScreen: Schema.Boolean, heldScreens: Schema.Natural,
})
const PresentationPath = Schema.Struct({ state: Schema.String,
  failure: Schema.optional(Schema.Struct({ code: Schema.String })),
})
const DeviceCounts = Schema.Struct({ microphone: Schema.Natural, output: Schema.Natural, camera: Schema.Natural })
const PickerResult = Schema.Struct({ sourceId: Schema.String, count: Schema.Natural, thumbnail: Schema.Boolean, cancelled: Schema.Boolean })

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(25)
  }
  throw new Error(`${label}_deadline`)
}

async function run() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(rendererHtml)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('renderer_server_unavailable')
  const url = `http://127.0.0.1:${address.port}`
  const window = new BrowserWindow({
    show: false, width: 1100, height: 760,
    webPreferences: { preload: path.join(app.getAppPath(), 'out/preload/index.cjs'), contextIsolation: true, sandbox: true,
      backgroundThrottling: false },
  })
  const adapter = createNativeRtcEngineAdapter()
  registerNativeMediaRuntimeIpc(() => window)
  registerDisplayMediaIpc(() => window)
  installMediaPermissions(url, () => window)
  const phases: Array<{ name: string; atUnixMs: number; revision: number | null; paths: Record<string, string>; failures: Record<string, unknown> }> = []
  const phase = (name: string) => {
    const snapshot = adapter.snapshot()
    const value = { name, atUnixMs: Date.now(), revision: snapshot.acceptedRevision,
      paths: Object.fromEntries(Object.entries(snapshot.tracks).map(([key, value]) => [key, value.state])),
      failures: Object.fromEntries(Object.entries(snapshot.tracks).filter(([, value]) => value.failure)
        .map(([key, value]) => [key, value.failure?.code])) }
    phases.push(value)
    process.stdout.write(`MEDIA_PRODUCT_PHASE ${JSON.stringify(value)}\n`)
  }
  const metrics = async () => Schema.decodeUnknownSync(RendererMetrics)(
    await window.webContents.executeJavaScript('window.fixture'))
  const screenPresentation = async () => Schema.decodeUnknownSync(PresentationPath)(
    await window.webContents.executeJavaScript('window.syrnikeDesktop.media.getRuntimeState().then(value => value.paths.screen_preview)'))
  let failure: string | undefined
  let desired: VoiceMediaDesiredState = createInitialVoiceMediaDesiredState()
  let devices: typeof DeviceCounts.Type | undefined
  let picker: typeof PickerResult.Type | undefined
  let beforeReload: typeof RendererMetrics.Type | undefined
  let afterReload: typeof RendererMetrics.Type | undefined
  const rendererFaults: Array<{ id: string; passed: number; required: number; maximumIterationMs: number;
    maximumDetectionMs: number; maximumRetainedTextures: number; minimumIncomingFrames: number | null }> = []
  let cleanupCompleted = false
  const saveReport = () => {
    const report = { accepted: !failure && cleanupCompleted, cleanupCompleted,
      appCommit: __DESKTOP_COMMIT_SHA__, processId: process.pid,
      scope: 'production-adapter-utility-preload-with-isolated-SFU',
      backendAuthority: 'not-tested', failure, phases, devices,
      picker: picker ? { count: picker.count, thumbnail: picker.thumbnail, cancelled: picker.cancelled } : undefined,
      beforeReload, afterReload, rendererFaults, physicalCamera: devices?.camera ? 'tested' : 'unavailable' }
    writeFileSync(environment.MEDIA_PRODUCT_REPORT, `${JSON.stringify(report, null, 2)}\n`)
  }
  try {
    await window.loadURL(url)
    window.showInactive()
    await until(async () => (await metrics()).ready, 'renderer_ready')
    await Effect.runPromise(adapter.prewarmMicrophoneEffect())
    devices = Schema.decodeUnknownSync(DeviceCounts)(await window.webContents.executeJavaScript(`(async () => {
      const media = window.syrnikeDesktop.media;
      const [microphone, output, camera] = await Promise.all([
        media.listDevices('audioinput'), media.listDevices('audiooutput'), media.listDevices('videoinput')
      ]);
      return { microphone: microphone.length, output: output.length, camera: camera.length };
    })()`))
    phase('devices_enumerated')
    picker = Schema.decodeUnknownSync(PickerResult)(await window.webContents.executeJavaScript(`(async () => {
      const media = window.syrnikeDesktop.media;
      const first = await media.openDisplayPicker(true);
      const page = await media.getDisplaySources(first.id, 0);
      const screen = page.sources.find(source => source.type === 'screen');
      if (!screen) throw Error('screen_source_missing');
      const visual = await media.getDisplaySourceVisual(first.id, screen.id);
      await media.cancelRequest(first.id);
      const cancelled = !(await media.selectDisplaySource(first.id, screen.id));
      return { sourceId: screen.id, count: page.sources.length, thumbnail: Boolean(visual?.thumbnailDataUrl), cancelled };
    })()`))
    if (!picker.cancelled) throw new Error('picker_cancel_failed')
    if (!devices.microphone || !devices.output) throw new Error('physical_audio_device_missing')
    phase('picker_cancelled')
    await adapter.connect({
      channelId: 'native-product-check', rtcEngine: 'windows_native', clientInstanceId: 'product-check',
      operationId: 'join-1', connectionEpoch: 'connection-1', authorityVersion: 1,
      credential: { url: environment.LIVEKIT_URL, token: environment.LIVEKIT_PUBLISHER_TOKEN, participantIdentity: 'product-publisher', cameraProfiles: ['hd720p30', 'hd1080p30'] },
    }, desired, new AbortController().signal)
    await until(() => adapter.snapshot().tracks.microphone.state === 'muted', 'muted_microphone')
    phase('joined_muted')
    desired = { ...desired, userMuted: false, effectiveMuted: false, voiceGateEnabled: false }
    adapter.updateDesiredMedia(desired)
    await until(() => adapter.snapshot().tracks.microphone.state === 'running', 'unmuted_microphone')
    phase('unmuted')
    desired = { ...desired, screenEnabled: true, screenAudioEnabled: true, screenAudioMode: 'system',
      screenSourceId: picker.sourceId, screenWidth: 1920, screenHeight: 1080, screenFps: 60, screenBitrate: 8_000_000 }
    adapter.updateDesiredMedia(desired)
    await window.webContents.executeJavaScript(`window.syrnikeDesktop.media.setLocalScreenPreviewDemand({ demanded: true, width: 960, height: 540, fps: 30 })`)
    await until(() => adapter.snapshot().tracks.screen.state === 'running' &&
      adapter.snapshot().tracks.screen_audio.state === 'running', 'screen_running')
    await until(async () => (await metrics()).screen >= 10, 'screen_preview')
    phase('screen_and_audio')
    if (devices.camera > 0) {
      desired = { ...desired, cameraEnabled: true, cameraProfile: 'hd720p30' }
      adapter.updateDesiredMedia(desired)
      await until(() => adapter.snapshot().tracks.camera.state === 'running', 'camera_running')
      await until(async () => (await metrics()).camera >= 10, 'camera_preview')
      phase('all_media')
    }
    await delay(3_000)
    desired = { ...desired, userMuted: true, effectiveMuted: true }
    adapter.updateDesiredMedia(desired)
    await until(() => adapter.snapshot().tracks.microphone.state === 'muted', 'mute_with_video')
    phase('muted_with_video')
    desired = { ...desired, userDeafened: true }
    adapter.updateDesiredMedia(desired)
    await until(() => adapter.snapshot().tracks.output.state === 'muted', 'deafened_output')
    phase('deafened')
    await delay(3_000)
    if (adapter.snapshot().tracks.screen_audio.state !== 'running') throw new Error('deafen_stopped_screen_audio')
    phase('deafened_with_screen_audio')
    desired = { ...desired, userDeafened: false }
    adapter.updateDesiredMedia(desired)
    await until(() => adapter.snapshot().tracks.output.state === 'running', 'restored_output')
    beforeReload = await metrics()
    const roomLeaseId = adapter.desiredSnapshot()?.room?.credentialLeaseId
    await window.loadURL(url)
    await until(async () => (await metrics()).ready, 'replacement_renderer')
    await window.webContents.executeJavaScript(`window.syrnikeDesktop.media.setLocalScreenPreviewDemand({ demanded: true, width: 960, height: 540, fps: 30 })`)
    await until(async () => (await metrics()).screen >= 10, 'replacement_screen_preview')
    if (devices.camera > 0) await until(async () => (await metrics()).camera >= 10, 'replacement_camera_preview')
    if (adapter.snapshot().roomState !== 'connected' || adapter.desiredSnapshot()?.room?.credentialLeaseId !== roomLeaseId)
      throw new Error('renderer_reload_changed_room')
    afterReload = await metrics()
    phase('renderer_reloaded')
    if (environment.MEDIA_PRODUCT_RENDERER_FAULTS === '1') {
      if (!devices.camera) throw new Error('renderer_fault_camera_missing')
      desired = { ...desired, userMuted: false, effectiveMuted: false }
      adapter.updateDesiredMedia(desired)
      await until(() => adapter.snapshot().tracks.microphone.state === 'running', 'fault_microphone_running')
      await until(async () => (await metrics()).remote >= 10, 'incoming_companion_video')
      for (const id of ['renderer-reload', 'renderer-crash', 'renderer-release-stall']) {
        const row: typeof rendererFaults[number] = { id, passed: 0, required: 100, maximumIterationMs: 0,
          maximumDetectionMs: 0, maximumRetainedTextures: 0, minimumIncomingFrames: null }
        rendererFaults.push(row)
        process.stdout.write(`MEDIA_PRODUCT_RENDERER_FAULT ${JSON.stringify({ id, event: 'begin' })}\n`)
        for (let iteration = 0; iteration < 100; ++iteration) {
          const started = performance.now()
          const previous = await metrics()
          if (id === 'renderer-crash') {
            let crashed = false
            const onGone = () => { crashed = true }
            window.webContents.once('render-process-gone', onGone)
            try {
              window.webContents.forcefullyCrashRenderer()
              await until(() => crashed, 'renderer_crash_observed')
            } finally { window.webContents.removeListener('render-process-gone', onGone) }
          }
          if (id === 'renderer-release-stall') {
            await window.webContents.executeJavaScript('window.fixture.holdScreen = true')
            await until(async () => (await screenPresentation()).failure?.code === 'video_bridge_receiver_release_timeout',
              'held_screen_release_detection', 3_000)
            row.maximumDetectionMs = Math.max(row.maximumDetectionMs, performance.now() - started)
            const held = await metrics()
            const transfers = electronFrameTransfers().metrics()
            row.maximumRetainedTextures = Math.max(row.maximumRetainedTextures, transfers.retained)
            if (held.heldScreens !== 2 || transfers.awaitingReceiverRelease < 2 || transfers.retained > 68 ||
                held.camera <= previous.camera || held.remote <= previous.remote)
              throw new Error('held_screen_reference_or_unaffected_media_failed')
            await window.webContents.executeJavaScript('window.releaseHeldScreens()')
            await until(async () => (await screenPresentation()).state === 'running' &&
              (await metrics()).screen >= previous.screen + 10, 'held_screen_release_recovery', 3_000)
          } else {
            await window.loadURL(url)
            await until(async () => (await metrics()).ready, 'fault_renderer_ready')
            await window.webContents.executeJavaScript(`window.syrnikeDesktop.media.setLocalScreenPreviewDemand({ demanded: true, width: 960, height: 540, fps: 30 })`)
            await until(async () => {
              const value = await metrics()
              return value.screen >= 10 && value.camera >= 10 && value.remote >= 10
            }, 'fault_renderer_media')
          }
          const current = await metrics()
          const snapshot = adapter.snapshot()
          const incomingFrames = id === 'renderer-release-stall' ? current.remote - previous.remote : current.remote
          row.minimumIncomingFrames = Math.min(row.minimumIncomingFrames ?? incomingFrames, incomingFrames)
          if (current.failures || !current.remoteAlias || current.remoteAlias !== previous.remoteAlias ||
              incomingFrames < 10 || current.epoch !== previous.epoch || snapshot.roomState !== 'connected' ||
              adapter.desiredSnapshot()?.room?.credentialLeaseId !== roomLeaseId ||
              (['screen', 'screen_audio', 'camera', 'microphone', 'output'] as const).some(key => snapshot.tracks[key].state !== 'running'))
            throw new Error('renderer_fault_changed_media_owner')
          const elapsedMs = performance.now() - started
          row.maximumIterationMs = Math.max(row.maximumIterationMs, elapsedMs)
          ++row.passed
          process.stdout.write(`MEDIA_PRODUCT_RENDERER_FAULT ${JSON.stringify({ id, event: 'completed', iteration, elapsedMs })}\n`)
        }
      }
    }
    desired = { ...desired, screenAudioEnabled: false }
    adapter.updateDesiredMedia(desired)
    await until(() => adapter.snapshot().tracks.screen_audio.state === 'off' &&
      adapter.snapshot().tracks.screen.state === 'running', 'independent_audio_stop')
    phase('screen_audio_stopped')
    await adapter.disconnect('leave')
    phase('left')
    if (beforeReload.failures || afterReload.failures) throw new Error('renderer_presentation_failed')
  } catch (error) {
    beforeReload ??= await metrics().catch(() => undefined)
    failure = error instanceof Error && error.message ? error.message.slice(0, 128) : 'product_check_failed'
    phase('failed')
  } finally {
    // Preserve the original outcome even when native teardown exceeds its budget.
    saveReport()
    try {
      await disposeWithinDesktopShutdownBudget({
        disposeVoice: async () => undefined,
        disposeRemaining: async () => {
          await adapter.dispose()
          await Effect.runPromise(flushNativeMediaDiagnosticsEffect())
          window.destroy()
          await new Promise<void>(resolve => server.close(() => resolve()))
          cleanupCompleted = true
        },
        onVoiceDisposeError: () => { failure ??= 'product_cleanup_failed' },
        onVoiceDeadlineExceeded: () => { failure ??= 'product_cleanup_deadline' },
        onDeadlineSettled: () => undefined,
        forceExit: () => {
          failure ??= 'product_cleanup_deadline'
          saveReport()
          app.exit(1)
        },
      })
    } catch { failure ??= 'product_cleanup_failed' }
    if (!cleanupCompleted) failure ??= 'product_cleanup_deadline'
    saveReport()
  }
  if (failure) throw new Error(failure)
}

app.whenReady().then(run).then(() => app.exit(0), error => {
  process.stderr.write(`MEDIA_PRODUCT_FAILED ${error instanceof Error ? error.message : 'unknown'}\n`, () => app.exit(1))
})
