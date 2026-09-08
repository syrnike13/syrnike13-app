// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NativeMediaRuntimeState } from '@syrnike13/platform'

const inactivePath: NativeMediaRuntimeState['paths']['screen'] = { revision: 0, state: 'off', warning: false }
const unavailableState: NativeMediaRuntimeState = {
  available: false,
  status: 'unavailable',
  restartCount: 0,
  hostEpoch: 0,
  paths: {
    microphone: inactivePath, camera: inactivePath, screen: inactivePath, output: inactivePath,
    screen_audio: inactivePath, screen_preview: inactivePath, camera_preview: inactivePath, remote_video: inactivePath,
  },
  failure: {
    code: 'native_media_unavailable',
    message: 'Native media is unavailable while the v2 engine is rebuilt.',
    retryable: false,
    stage: 'native_runtime',
  },
}

const mediaRuntime = vi.hoisted(() => {
  const listeners = new Set<(value: NativeMediaRuntimeState) => void>()
  return {
    getRuntimeState: vi.fn<() => Promise<NativeMediaRuntimeState>>(),
    retryRuntime: vi.fn(),
    dispatch: vi.fn(),
    onRuntimeState: vi.fn((listener: (value: NativeMediaRuntimeState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    emit(next: NativeMediaRuntimeState) {
      for (const listener of listeners) listener(next)
    },
    reset() {
      listeners.clear()
      this.getRuntimeState.mockReset()
      this.retryRuntime.mockReset()
      this.dispatch.mockReset()
      this.onRuntimeState.mockClear()
    },
  }
})

vi.mock('#/platform/use-platform', () => {
  const platform = { desktop: { media: mediaRuntime, voice: { dispatch: mediaRuntime.dispatch } } }
  return { usePlatform: () => platform }
})

import { NativeMediaRuntimeBanner } from './native-media-runtime-banner'

describe('NativeMediaRuntimeBanner', () => {
  afterEach(cleanup)

  beforeEach(() => {
    mediaRuntime.reset()
    mediaRuntime.getRuntimeState.mockResolvedValue(unavailableState)
  })

  it('shows the finite unavailable state without offering a restart', async () => {
    render(<NativeMediaRuntimeBanner />)

    expect(
      await screen.findByText(
        'Нативные медиа недоступны на этом устройстве.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(mediaRuntime.retryRuntime).not.toHaveBeenCalled()
  })

  it('accepts a pushed unavailable state while the initial request is pending', async () => {
    mediaRuntime.getRuntimeState.mockImplementationOnce(() => new Promise(() => {}))
    render(<NativeMediaRuntimeBanner />)

    await act(async () => {
      mediaRuntime.emit(unavailableState)
    })

    expect(
      screen.getByText(
        'Нативные медиа недоступны на этом устройстве.',
      ),
    ).toBeTruthy()
  })

  it('hides healthy state and clears one screen warning on recovery and stop', async () => {
    const healthy: NativeMediaRuntimeState = { ...unavailableState, available: true, status: 'ready', failure: undefined }
    mediaRuntime.getRuntimeState.mockResolvedValue(healthy)
    render(<NativeMediaRuntimeBanner />)
    await act(async () => {})
    expect(screen.queryByRole('status')).toBeNull()
    const warning: NativeMediaRuntimeState = {
      ...healthy, paths: { ...healthy.paths, screen: { revision: 1, state: 'running', warning: true } },
    }
    for (let index = 0; index < 3; index += 1) await act(async () => mediaRuntime.emit(warning))
    expect(screen.getAllByText('Демонстрация может идти с задержками. Попробуйте снизить качество вручную')).toHaveLength(1)
    expect(screen.queryByRole('button')).toBeNull()
    await act(async () => mediaRuntime.emit(healthy))
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => mediaRuntime.emit(warning))
    await act(async () => mediaRuntime.emit({ ...warning, paths: { ...warning.paths, screen: { ...inactivePath, warning: true } } }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('names only the failed path without exposing technical failure details', async () => {
    mediaRuntime.getRuntimeState.mockResolvedValue({
      ...unavailableState, available: true, status: 'ready',
      paths: { ...unavailableState.paths, camera_preview: {
        revision: 1, state: 'failed', warning: false,
        failure: { code: 'mft_failed', message: 'HRESULT device details', retryable: true, stage: 'preview' },
      } },
    })
    render(<NativeMediaRuntimeBanner />)
    expect(await screen.findByText('Предпросмотр камеры: недоступно.')).toBeTruthy()
    expect(screen.queryByText(/HRESULT/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('explains camera rollback while the previous capture remains running', async () => {
    const healthy: NativeMediaRuntimeState = {
      ...unavailableState, available: true, status: 'ready', failure: undefined,
    }
    mediaRuntime.getRuntimeState.mockResolvedValue({
      ...healthy, paths: { ...healthy.paths, camera: {
        revision: 2, state: 'running', warning: true,
        failure: { code: 'camera_input_failed', message: 'Private device details', retryable: true, stage: 'camera' },
      } },
    })
    render(<NativeMediaRuntimeBanner />)
    expect(await screen.findByText('Не удалось применить настройки камеры. Продолжаем использовать предыдущие настройки.')).toBeTruthy()
    expect(screen.queryByText(/Private device/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    await act(async () => mediaRuntime.emit(healthy))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('asks for source selection once when an expired source affects screen video and audio', async () => {
    const expiredSource: NativeMediaRuntimeState['paths']['screen'] = {
      revision: 3, state: 'failed', warning: false,
      failure: { code: 'screen_source_unavailable', message: '', retryable: false, stage: 'screen' },
    }
    mediaRuntime.getRuntimeState.mockResolvedValue({
      ...unavailableState, available: true, status: 'ready', failure: undefined,
      paths: { ...unavailableState.paths, screen: expiredSource, screen_audio: expiredSource },
    })
    render(<NativeMediaRuntimeBanner />)
    expect(await screen.findByText('Источник демонстрации недоступен. Выберите экран или приложение заново.')).toBeTruthy()
    expect(screen.queryByText('Звук демонстрации: недоступно.')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers one manual runtime retry only for a retryable runtime failure', async () => {
    mediaRuntime.getRuntimeState.mockResolvedValue({
      ...unavailableState, available: true, status: 'failed',
      failure: { code: 'host_failed', message: '', retryable: true, stage: 'host' },
    })
    mediaRuntime.retryRuntime.mockResolvedValue(undefined)
    render(<NativeMediaRuntimeBanner />)
    const retry = await screen.findByRole('button', { name: 'Повторить запуск' })
    await act(async () => fireEvent.click(retry))
    expect(mediaRuntime.retryRuntime).toHaveBeenCalledTimes(1)
  })

  it('retries only the failed media path while the runtime and Room remain available', async () => {
    mediaRuntime.getRuntimeState.mockResolvedValue({
      ...unavailableState, available: true, status: 'ready',
      paths: { ...unavailableState.paths, microphone: {
        revision: 2, state: 'failed', warning: false,
        failure: { code: 'microphone_sender_failed', message: '', retryable: true, stage: 'microphone' },
      } },
    })
    mediaRuntime.dispatch.mockResolvedValue(undefined)
    render(<NativeMediaRuntimeBanner />)
    const retry = await screen.findByRole('button', { name: 'Повторить запуск микрофона' })
    await act(async () => fireEvent.click(retry))
    expect(mediaRuntime.dispatch).toHaveBeenCalledWith({ type: 'retryMedia', kind: 'microphone' })
    expect(mediaRuntime.retryRuntime).not.toHaveBeenCalled()
  })
})
