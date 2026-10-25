// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoicePanelMediaBar } from './voice-panel-media-bar'

// Navigation assertions must not start Iconify requests/timers that can outlive
// the jsdom environment. Icons are decorative in this control-flow test.
vi.mock('#/components/icons', () => ({
  ActivityIcon: () => null,
  Loader2Icon: () => null,
  MonitorUpIcon: () => null,
  MonitorXIcon: () => null,
  SoundboardIcon: () => null,
  VideoIcon: () => null,
  VideoOffIcon: () => null,
}))

const testState = vi.hoisted(() => ({
  session: { status: 'connected', channelId: 'voice-a' },
  navigate: vi.fn(() => Promise.resolve()),
  activitiesAllowed: true,
  activityRunning: false,
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
  useAppRoutePrefix: () => '',
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


vi.mock('#/features/authorization/authorization', () => ({
  canUseActivities: () => testState.activitiesAllowed,
}))

vi.mock('#/features/sync/sync-store', () => ({
  useSyncStore: (selector: (state: unknown) => unknown) => selector({}),
}))

vi.mock('#/features/activities/use-activities', () => ({
  useActivityInstance: () => (testState.activityRunning ? {} : null),
}))

describe('VoicePanelMediaBar Activities button', () => {
  beforeEach(() => {
    testState.session.status = 'connected'
    testState.activitiesAllowed = true
    testState.activityRunning = false
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
      to: '/c/$channelId',
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

  it('disables Activities without the UseActivities permission', () => {
    testState.activitiesAllowed = false

    render(<VoicePanelMediaBar />)

    const button = screen.getByRole('button', {
      name: 'Активности: нет права на запуск',
    })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(testState.navigate).not.toHaveBeenCalled()
  })

  it('keeps Activities available to join a running one without the permission', () => {
    testState.activitiesAllowed = false
    testState.activityRunning = true

    render(<VoicePanelMediaBar />)

    expect(
      screen
        .getByRole('button', { name: 'Активности' })
        .getAttribute('aria-disabled'),
    ).not.toBe('true')
  })
})
