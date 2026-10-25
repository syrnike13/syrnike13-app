import { useEffect, useRef, useState } from 'react'
import { Effect, Fiber } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import type { NativeMediaRuntimeState, VoiceMediaKind } from '@syrnike13/platform'

import { TriangleAlertIcon } from '#/components/icons'
import { usePlatform } from '#/platform/use-platform'
import { Button } from '@syrnike13/ui/primitives/button'

const pathLabelKeys: ReadonlyArray<
  readonly [keyof NativeMediaRuntimeState['paths'], string]
> = [
  ['microphone', 'paths.microphone'],
  ['camera', 'paths.camera'],
  ['screen', 'paths.screen'],
  ['output', 'paths.output'],
  ['screen_audio', 'paths.screenAudio'],
  ['screen_preview', 'paths.screenPreview'],
  ['camera_preview', 'paths.cameraPreview'],
  ['remote_video', 'paths.remoteVideo'],
]
const retryablePaths: ReadonlyArray<readonly [VoiceMediaKind, string]> = [
  ['microphone', 'retry.microphone'],
  ['output', 'retry.output'],
  ['camera', 'retry.camera'],
  ['screen', 'retry.screen'],
  ['screen_audio', 'retry.screenAudio'],
]

export function NativeMediaRuntimeBanner() {
  const t = useTranslations('nativeMedia')
  const { desktop } = usePlatform()
  const [state, setState] = useState<NativeMediaRuntimeState | null>(null)
  const pushedStateRevision = useRef(0)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    if (!desktop) return
    const unsubscribe = desktop.media.onRuntimeState((next) => {
      pushedStateRevision.current += 1
      setState(next)
    })
    const initialRevision = pushedStateRevision.current
    const fiber = Effect.runFork(
      Effect.tryPromise({
        try: () => desktop.media.getRuntimeState(),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            if (pushedStateRevision.current === initialRevision) setState(next)
          }),
        ),
        Effect.ignore,
      ),
    )
    return () => {
      unsubscribe()
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [desktop])

  if (!desktop || !state) return null

  const messages: string[] = []
  if (state.status === 'unavailable') messages.push(t('unavailable'))
  else if (state.status === 'recovering') messages.push(t('recovering'))
  else if (state.status === 'failed') messages.push(t('failed'))
  else if (state.status === 'ready') {
    for (const [key, labelKey] of pathLabelKeys) {
      if (state.paths[key].state !== 'failed') continue
      if (key === 'camera' && state.paths.camera.failure?.code === 'camera_profile_not_permitted') {
        messages.push(t('cameraProfileNotPermitted'))
      } else if (key === 'screen' && state.paths.screen.failure?.code === 'screen_source_unavailable') {
        messages.push(t('screenSourceUnavailable'))
      } else if (key === 'screen_audio' && state.paths.screen_audio.failure?.code === 'screen_source_unavailable' &&
          state.paths.screen.failure?.code === 'screen_source_unavailable') {
        continue
      } else messages.push(t('pathUnavailable', { label: t(labelKey) }))
    }
    if (state.paths.camera.warning && state.paths.camera.state === 'running') {
      messages.push(t('cameraSettingsNotApplied'))
    }
  }
  if (messages.length === 0) return null

  const canRetry = state.status === 'failed' && state.failure?.retryable && state.available
  const retry = () => {
    if (retrying) return
    setRetrying(true)
    Effect.runFork(Effect.tryPromise({
      try: () => desktop.media.retryRuntime(), catch: cause => cause,
    }).pipe(
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => setRetrying(false))),
    ))
  }
  const retryPath = (kind: VoiceMediaKind) => {
    if (retrying) return
    setRetrying(true)
    Effect.runFork(Effect.tryPromise({
      try: () => desktop.voice.dispatch({ type: 'retryMedia', kind }),
      catch: cause => cause,
    }).pipe(
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => setRetrying(false))),
    ))
  }

  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive-foreground"
      role="status"
      aria-live="polite"
    >
      <TriangleAlertIcon className="size-3.5" aria-hidden />
      <span>{messages.join(' ')}</span>
      {canRetry ? (
        <Button type="button" variant="plain" size="inline" className="shrink-0 underline" disabled={retrying} onClick={retry}>
          {retrying ? t('retrying') : t('retryAction')}
        </Button>
      ) : null}
      {state.status === 'ready' && state.available ? retryablePaths.map(([kind, labelKey]) =>
        state.paths[kind].state === 'failed' && state.paths[kind].failure?.retryable ? (
          <Button key={kind} type="button" variant="plain" size="inline" className="shrink-0 underline" disabled={retrying}
            onClick={() => retryPath(kind)}>{t(labelKey)}</Button>
        ) : null,
      ) : null}
    </div>
  )
}
