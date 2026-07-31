// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceScreenShareStrip } from './voice-local-broadcast-strip'

const toggleScreenShareMock = vi.hoisted(() => vi.fn())

vi.mock('#/features/voice/voice-session-context', () => ({
  useVoiceSession: () => ({ status: 'connected' }),
}))

vi.mock('#/features/voice/voice-media-context', () => ({
  useVoiceMedia: () => ({
    screenShareEnabled: true,
    toggleScreenShare: toggleScreenShareMock,
  }),
}))

vi.mock('#/features/voice/voice-stage-context', () => ({
  useVoiceStage: () => ({
    stageMediaItems: [
      {
        id: 'local:screen',
        kind: 'screen',
        isLocal: true,
        track: {
          mediaStreamTrack: {
            label: 'screen:0',
            getSettings: () => ({ displaySurface: 'monitor' }),
          },
        },
      },
    ],
  }),
}))

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({ desktop: null }),
}))

describe('VoiceScreenShareStrip', () => {
  beforeEach(() => {
    toggleScreenShareMock.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the shared source and stops it from the compact button', () => {
    render(<VoiceScreenShareStrip />)

    expect(screen.getByText('Экран 1')).toBeTruthy()

    const stopButton = screen.getByRole('button', {
      name: 'Остановить демонстрацию',
    })
    expect(stopButton.className).toContain('size-8')

    fireEvent.click(stopButton)

    expect(toggleScreenShareMock).toHaveBeenCalledTimes(1)
  })
})
