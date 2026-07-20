// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStageControls } from './voice-stage-controls'

const voiceJoinMock = vi.hoisted(() => vi.fn())
const voiceLeaveMock = vi.hoisted(() => vi.fn())

vi.mock('#/features/voice/voice-session-context', () => ({
  useVoiceSession: () => ({
    micEnabled: true,
    micPublishing: false,
    deafened: false,
    toggleMic: vi.fn(),
    toggleDeafen: vi.fn(),
    leave: voiceLeaveMock,
    join: voiceJoinMock,
  }),
}))

vi.mock('#/features/voice/voice-media-context', () => ({
  useVoiceMedia: () => ({
    cameraEnabled: false,
    screenShareEnabled: false,
    screenShareStarting: false,
    mediaAvailability: {
      microphone: 'available',
      camera: 'available',
      screenShare: 'available',
    },
    toggleCamera: vi.fn(),
    toggleScreenShare: vi.fn(),
  }),
}))

vi.mock('#/features/voice/voice-stage-context', () => ({
  useVoiceStage: () => ({
    stageMediaFilters: {
      avatars: true,
      camera: true,
      screen: true,
    },
    setStageMediaFilters: vi.fn(),
  }),
}))

describe('VoiceStageControls', () => {
  beforeEach(() => {
    voiceJoinMock.mockClear()
    voiceLeaveMock.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('uses a call-specific join label when provided', () => {
    render(
      <VoiceStageControls
        channelId="group-1"
        inCall={false}
        connecting={false}
        overlay
        joinLabel="Присоединиться"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Присоединиться' }))

    expect(voiceJoinMock).toHaveBeenCalledWith('group-1')
    expect(screen.queryByRole('button', { name: 'Подключиться к голосу' })).toBeNull()
  })

  it('exits the focused stream without disconnecting from voice', () => {
    const exitViewSession = vi.fn()
    const streamSession = {
      id: 'stream:alice:screen',
      stageItemId: 'alice:screen',
      kind: 'stream' as const,
      label: 'Alice',
    }

    render(
      <VoiceStageControls
        channelId="voice-1"
        inCall
        connecting={false}
        overlay
        viewSessions={[streamSession]}
        focusedStageItemId="alice:screen"
        onExitViewSession={exitViewSession}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Прекратить просмотр — Alice',
      }),
    )

    expect(exitViewSession).toHaveBeenCalledWith(streamSession)
    expect(voiceLeaveMock).not.toHaveBeenCalled()
  })

  it('offers every active view session from the exit dropdown', async () => {
    const exitViewSession = vi.fn()
    const activitySession = {
      id: 'activity:counter-1',
      stageItemId: 'activity:counter-1',
      kind: 'activity' as const,
      label: 'Общий счётчик',
      channelId: 'voice-1',
      instanceId: 'counter-1',
    }

    render(
      <VoiceStageControls
        channelId="voice-1"
        inCall
        connecting={false}
        overlay
        viewSessions={[
          {
            id: 'stream:alice:screen',
            stageItemId: 'alice:screen',
            kind: 'stream',
            label: 'Alice',
          },
          activitySession,
        ]}
        onExitViewSession={exitViewSession}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Отключиться от голоса' }),
    ).toBeTruthy()

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Выбрать, что завершить' }),
      { button: 0, ctrlKey: false },
    )

    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: 'Выйти из активности — Общий счётчик',
      }),
    )

    expect(exitViewSession).toHaveBeenCalledWith(activitySession)
    expect(voiceLeaveMock).not.toHaveBeenCalled()
  })
})
