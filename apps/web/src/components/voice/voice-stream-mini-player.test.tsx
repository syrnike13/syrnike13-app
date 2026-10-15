// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  channelId: 'text',
  navigate: vi.fn(),
  stage: {
    stageChannelId: 'voice',
    streamMediaItems: [
      {
        id: 'alice:screen',
        userId: 'alice',
        kind: 'screen',
        isLocal: false,
        live: true,
      },
    ],
    viewedRemoteScreenIds: ['alice:screen'],
    focusedMediaId: 'alice:screen',
    mountedStageChannelIds: Array<string>(),
    popoutWindow: null,
    stageFullscreen: false,
    setFocusedMediaId: vi.fn(),
    setStageMediaSubscribed: vi.fn(),
    openStagePopout: vi.fn(),
  },
}))
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ channelId: state.channelId }),
  useNavigate: () => state.navigate,
}))
vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({ user: undefined }),
}))
vi.mock('#/features/voice/voice-stage-context', () => ({
  useVoiceStage: () => state.stage,
}))
vi.mock('#/features/diagnostics/diagnostic-reporter', () => ({
  recordDiagnosticEvent: vi.fn(),
}))
import { VoiceStreamMiniPlayer } from './voice-stream-mini-player'
import {
  MINI_PLAYER_CORNER_KEY,
  MINI_PLAYER_WIDTH_KEY,
} from '#/features/voice/stream-mini-player'

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number
  readonly isPrimary: boolean
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
    this.isPrimary = init.isPrimary ?? true
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  state.channelId = 'text'
  state.stage.streamMediaItems[0].isLocal = false
  state.stage.viewedRemoteScreenIds = ['alice:screen']
  state.stage.mountedStageChannelIds = []
  state.stage.stageFullscreen = false
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture')
})

describe('mini player controls and pointer interactions', () => {
  it('returns to the voice channel and focuses the shown stream', () => {
    render(<VoiceStreamMiniPlayer />)
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Вернуться в канал' })[0],
    )
    expect(state.stage.setFocusedMediaId).toHaveBeenCalledWith('alice:screen')
    expect(state.navigate).toHaveBeenCalledWith({
      to: '/app/c/$channelId',
      params: { channelId: 'voice' },
      search: { m: undefined },
    })
  })
  it('stops remote viewing and opens the shared popout without navigating', () => {
    render(<VoiceStreamMiniPlayer />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Открыть в отдельном окне' }),
    )
    expect(state.stage.openStagePopout).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Прекратить просмотр' }))
    expect(state.stage.setStageMediaSubscribed).toHaveBeenCalledWith(
      'alice:screen',
      false,
    )
    expect(state.navigate).not.toHaveBeenCalled()
  })
  it('never offers stopping the local screenshare', () => {
    state.stage.streamMediaItems[0].isLocal = true
    state.stage.viewedRemoteScreenIds = []
    render(<VoiceStreamMiniPlayer />)
    expect(
      screen.queryByRole('button', { name: 'Прекратить просмотр' }),
    ).toBeNull()
  })
  it('snaps a drag to a persisted corner and suppresses its click', () => {
    render(<VoiceStreamMiniPlayer />)
    const player = screen.getByRole('region', { name: 'Мини-плеер трансляции' })
    fireEvent.pointerDown(player, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 500,
    })
    fireEvent.pointerMove(player, { pointerId: 1, clientX: 900, clientY: 100 })
    fireEvent.pointerUp(player, { pointerId: 1, clientX: 900, clientY: 100 })
    fireEvent.click(player)
    expect(window.localStorage.getItem(MINI_PLAYER_CORNER_KEY)).toBe(
      'top-right',
    )
    expect(state.navigate).not.toHaveBeenCalled()
    fireEvent.click(player)
    expect(state.navigate).toHaveBeenCalledOnce()
  })
  it('resizes at 16:9, persists width, and clamps again on window resize', () => {
    window.localStorage.setItem(MINI_PLAYER_WIDTH_KEY, '240')
    render(<VoiceStreamMiniPlayer />)
    const grip = screen.getByRole('button', {
      name: 'Изменить размер мини-плеера',
    })
    const player = screen.getByRole('region', { name: 'Мини-плеер трансляции' })
    fireEvent.pointerDown(grip, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 240,
      clientY: 400,
    })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 320, clientY: 400 })
    fireEvent.pointerUp(grip, { pointerId: 1 })
    fireEvent.click(grip)
    expect(player.style.width).toBe('320px')
    expect(player.style.aspectRatio).toBe('16 / 9')
    expect(window.localStorage.getItem(MINI_PLAYER_WIDTH_KEY)).toBe('320')
    expect(state.navigate).not.toHaveBeenCalled()
    vi.stubGlobal('innerWidth', 600)
    act(() => window.dispatchEvent(new Event('resize')))
    expect(player.style.width).toBe('240px')
  })
})
