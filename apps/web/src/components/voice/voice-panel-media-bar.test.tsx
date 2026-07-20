// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoicePanelMediaBar } from './voice-panel-media-bar'

const testState = vi.hoisted(() => ({
  session: { status: 'connected', channelId: 'voice-a' },
  navigate: vi.fn(() => Promise.resolve()),
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

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => testState.navigate,
}))

vi.mock('#/features/navigation/route-prefix', () => ({
  useAppRoutePrefix: () => '/app',
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
    testState.navigate.mockClear()
  })

  afterEach(cleanup)

  it('navigates to the active voice stage before opening Activities', async () => {
    const { rerender } = render(<VoicePanelMediaBar />)
    const button = screen.getByRole('button', { name: 'Активности' })

    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(testState.navigate).toHaveBeenCalledWith({
      to: '/app/c/$channelId',
      params: { channelId: 'voice-a' },
      search: { m: undefined },
    })
    await vi.waitFor(() =>
      expect(testState.stage.setActivityLauncherOpen).toHaveBeenCalledWith(true),
    )

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
