// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStageControls } from './voice-stage-controls'

const voiceJoinMock = vi.hoisted(() => vi.fn())

vi.mock('#/features/voice/voice-session-context', () => ({
  useVoiceSession: () => ({
    micEnabled: true,
    micPublishing: false,
    deafened: false,
    toggleMic: vi.fn(),
    toggleDeafen: vi.fn(),
    leave: vi.fn(),
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
})
