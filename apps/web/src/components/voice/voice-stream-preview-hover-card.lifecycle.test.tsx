// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  fetch: vi.fn<() => Promise<Blob | null>>(),
  watch: vi.fn(),
}))
vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({ session: { token: 'test-token' }, user: { _id: 'self' } }),
}))
vi.mock('#/features/voice/voice-stage-context', () => ({
  useVoiceStage: () => ({ stageChannelId: 'voice', viewedRemoteScreenIds: [] }),
}))
vi.mock('#/features/voice/use-watch-participant-screen-share', () => ({
  useWatchParticipantScreenShare: () => state.watch,
}))
vi.mock('@syrnike13/client/api/client', () => ({ apiBlobRequest: state.fetch }))
vi.mock('#/features/diagnostics/diagnostic-reporter', () => ({
  recordDiagnosticEvent: vi.fn(),
}))
import { VoiceStreamPreviewHoverCard } from './voice-stream-preview-hover-card'
import { PortalContainerProvider } from '@syrnike13/ui/primitives/portal-container'

const createUrl = vi.fn(() => 'blob:test-preview')
const revokeUrl = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  state.fetch.mockResolvedValue(new Blob(['preview'], { type: 'image/webp' }))
  const RuntimeURL = URL
  vi.stubGlobal(
    'URL',
    class extends RuntimeURL {
      static createObjectURL = createUrl
      static revokeObjectURL = revokeUrl
    },
  )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('fetches only on hover, refreshes while open, uses its portal, and releases URLs on close', async () => {
  const portal = document.createElement('div')
  document.body.append(portal)
  const view = render(
    <PortalContainerProvider container={portal}>
      <VoiceStreamPreviewHoverCard channelId="voice" userId="streamer">
        <button>Streamer</button>
      </VoiceStreamPreviewHoverCard>
    </PortalContainerProvider>,
  )
  const trigger = screen.getByRole('button', { name: 'Streamer' }).parentElement!
  expect(state.fetch).not.toHaveBeenCalled()
  fireEvent.mouseEnter(trigger, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(state.fetch).toHaveBeenCalledTimes(1)
  expect(portal.textContent).toContain('Сейчас стримит')
  expect(state.watch).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(30_000))
  expect(state.fetch).toHaveBeenCalledTimes(2)
  expect(revokeUrl).toHaveBeenCalledTimes(1)
  fireEvent.mouseLeave(trigger, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(201))
  expect(revokeUrl).toHaveBeenCalledTimes(2)
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(state.fetch).toHaveBeenCalledTimes(2)
  view.unmount()
  portal.remove()
})

it('shows the unavailable state for a missing preview and invokes watch only from the button', async () => {
  state.fetch.mockResolvedValue(null)
  render(
    <VoiceStreamPreviewHoverCard channelId="voice" userId="streamer">
      <button>Streamer</button>
    </VoiceStreamPreviewHoverCard>,
  )
  fireEvent.mouseEnter(
    screen.getByRole('button', { name: 'Streamer' }).parentElement!,
    { pointerType: 'mouse' },
  )
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(screen.getByText('Превью пока недоступно')).toBeTruthy()
  expect(state.watch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Смотреть стрим' }))
  expect(state.watch).toHaveBeenCalledWith('voice', 'streamer')
})

it('dismisses on pointer down and stays closed while the click profile is open', async () => {
  const view = render(
    <VoiceStreamPreviewHoverCard channelId="voice" userId="streamer">
      <button>Streamer</button>
    </VoiceStreamPreviewHoverCard>,
  )
  const button = screen.getByRole('button', { name: 'Streamer' })
  const trigger = button.parentElement!
  fireEvent.mouseEnter(trigger, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(500))
  fireEvent.pointerDown(button)
  view.rerender(
    <VoiceStreamPreviewHoverCard channelId="voice" userId="streamer" suspended>
      <button>Streamer</button>
    </VoiceStreamPreviewHoverCard>,
  )
  fireEvent.mouseLeave(trigger)
  fireEvent.mouseEnter(trigger, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(31_000))
  expect(state.fetch).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('Сейчас стримит')).toBeNull()
})
