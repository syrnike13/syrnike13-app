// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStageControls } from './voice-stage-controls'

const voiceJoinMock = vi.hoisted(() => vi.fn())

vi.mock('#/features/voice/voice-context', () => ({
  useVoice: () => ({
    micEnabled: true,
    micPublishing: false,
    deafened: false,
    cameraEnabled: false,
    screenShareEnabled: false,
    screenShareStarting: false,
    mediaAvailability: {
      microphone: 'available',
      camera: 'available',
      screenShare: 'available',
    },
    toggleMic: vi.fn(),
    toggleDeafen: vi.fn(),
    toggleCamera: vi.fn(),
    toggleScreenShare: vi.fn(),
    leave: vi.fn(),
    join: voiceJoinMock,
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
