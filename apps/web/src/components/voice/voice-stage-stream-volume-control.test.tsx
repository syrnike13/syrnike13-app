// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStageStreamVolumeControl } from '#/components/voice/voice-stage-stream-volume-control'
import { voiceListenerStore } from '#/features/voice/voice-listener-store'

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('VoiceStageStreamVolumeControl', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    voiceListenerStore.setStreamMuted('stream-user', false)
    voiceListenerStore.setStreamVolume('stream-user', 1)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    voiceListenerStore.setStreamMuted('stream-user', false)
    voiceListenerStore.setStreamVolume('stream-user', 1)
  })

  it('toggles stream mute when the speaker button is clicked', () => {
    render(<VoiceStageStreamVolumeControl userId="stream-user" />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Выключить звук стрима' }),
    )

    expect(voiceListenerStore.getStreamMuted('stream-user')).toBe(true)
    expect(
      screen.getByRole('button', { name: 'Включить звук стрима' }),
    ).toBeTruthy()
  })

  it('renders a stream volume slider for accessibility', () => {
    render(<VoiceStageStreamVolumeControl userId="stream-user" />)

    expect(screen.getByLabelText('Громкость стрима')).toBeTruthy()
  })
})
