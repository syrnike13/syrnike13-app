// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoicePanelMediaBar } from './voice-panel-media-bar'

const testState = vi.hoisted(() => ({
  session: { status: 'connected' },
  uiFeatures: { channelActivities: true },
  stage: {
    activityLauncherOpen: false,
    focusedMediaId: null as string | null,
    setActivityLauncherOpen: vi.fn(),
  },
  media: {
    cameraEnabled: false,
    screenShareEnabled: false,
    screenShareStarting: false,
    mediaAvailability: {
      camera: { available: true, title: '' },
      screenShare: { available: true, title: '' },
    },
    toggleCamera: vi.fn(),
    toggleScreenShare: vi.fn(),
  },
}))

vi.mock('#/features/voice/voice-session-context', () => ({
  useVoiceSession: () => testState.session,
}))

vi.mock('#/features/voice/voice-stage-context', () => ({
  useVoiceStage: () => testState.stage,
}))

vi.mock('#/features/voice/voice-media-context', () => ({
  useVoiceMedia: () => testState.media,
}))

vi.mock('#/lib/ui-feature-flags', () => ({
  uiFeatureFlags: testState.uiFeatures,
}))

describe('VoicePanelMediaBar Activities button', () => {
  beforeEach(() => {
    testState.session.status = 'connected'
    testState.uiFeatures.channelActivities = true
    testState.stage.activityLauncherOpen = false
    testState.stage.focusedMediaId = null
    testState.stage.setActivityLauncherOpen.mockReset()
  })

  afterEach(cleanup)

  it('opens Activities from the voice panel button', () => {
    const { rerender } = render(<VoicePanelMediaBar />)
    const button = screen.getByRole('button', { name: 'Активности' })

    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(testState.stage.setActivityLauncherOpen).toHaveBeenCalledOnce()
    const update = testState.stage.setActivityLauncherOpen.mock
      .calls[0]?.[0] as (current: boolean) => boolean
    expect(update(false)).toBe(true)

    testState.stage.activityLauncherOpen = true
    rerender(<VoicePanelMediaBar />)
    expect(
      screen
        .getByRole('button', { name: 'Активности' })
        .getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('hides Activities outside nightly builds', () => {
    testState.uiFeatures.channelActivities = false

    render(<VoicePanelMediaBar />)

    expect(screen.queryByRole('button', { name: 'Активности' })).toBeNull()
  })
})
