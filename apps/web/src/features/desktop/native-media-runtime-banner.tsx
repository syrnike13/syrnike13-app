import { useEffect, useRef, useState } from 'react'
import { Effect, Fiber } from 'effect'

import type { NativeMediaRuntimeState, VoiceMediaKind } from '@syrnike13/platform'

import { TriangleAlertIcon } from '#/components/icons'
import { usePlatform } from '#/platform/use-platform'

const pathLabels: ReadonlyArray<readonly [keyof NativeMediaRuntimeState['paths'], string]> = [
  ['microphone', 'Микрофон'], ['camera', 'Камера'], ['screen', 'Демонстрация экрана'],
  ['output', 'Воспроизведение звука'], ['screen_audio', 'Звук демонстрации'],
  ['screen_preview', 'Предпросмотр демонстрации'], ['camera_preview', 'Предпросмотр камеры'],
  ['remote_video', 'Входящее видео'],
]
const screenWarning = 'Демонстрация может идти с задержками. Попробуйте снизить качество вручную'
const retryablePaths: ReadonlyArray<readonly [VoiceMediaKind, string]> = [
  ['microphone', 'Повторить запуск микрофона'],
  ['output', 'Повторить запуск звука'],
  ['camera', 'Повторить запуск камеры'],
  ['screen', 'Повторить демонстрацию'],
  ['screen_audio', 'Повторить запуск звука демонстрации'],
]

export function NativeMediaRuntimeBanner() {
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
  if (state.status === 'unavailable') messages.push('Нативные медиа недоступны на этом устройстве.')
  else if (state.status === 'recovering') messages.push('Восстанавливаем медиа…')
  else if (state.status === 'failed') messages.push('Не удалось запустить медиа.')
  else if (state.status === 'ready') {
    for (const [key, label] of pathLabels) {
      if (state.paths[key].state !== 'failed') continue
      if (key === 'camera' && state.paths.camera.failure?.code === 'camera_profile_not_permitted') {
        messages.push('Выбранное качество камеры недоступно для этого аккаунта или канала. Измените качество в настройках.')
      } else if (key === 'screen' && state.paths.screen.failure?.code === 'screen_source_unavailable') {
        messages.push('Источник демонстрации недоступен. Выберите экран или приложение заново.')
      } else if (key === 'screen_audio' && state.paths.screen_audio.failure?.code === 'screen_source_unavailable' &&
          state.paths.screen.failure?.code === 'screen_source_unavailable') {
        continue
      } else messages.push(`${label}: недоступно.`)
    }
    if (state.paths.screen.warning && state.paths.screen.state === 'running') messages.push(screenWarning)
    if (state.paths.camera.warning && state.paths.camera.state === 'running') {
      messages.push('Не удалось применить настройки камеры. Продолжаем использовать предыдущие настройки.')
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
      {canRetry ? <button type="button" className="shrink-0 underline" disabled={retrying} onClick={retry}>
        {retrying ? 'Запускаем…' : 'Повторить запуск'}
      </button> : null}
      {state.status === 'ready' && state.available ? retryablePaths.map(([kind, label]) =>
        state.paths[kind].state === 'failed' && state.paths[kind].failure?.retryable ? (
          <button key={kind} type="button" className="shrink-0 underline" disabled={retrying}
            onClick={() => retryPath(kind)}>{label}</button>
        ) : null,
      ) : null}
    </div>
  )
}
