// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Channel, User } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStageView } from './voice-stage-view'

const testState = vi.hoisted(() => ({
  session: {
    channelId: 'voice-a' as string | null,
    status: 'connected',
    micPublishing: true,
    deafened: false,
    speakingUserIds: new Set<string>(),
    join: vi.fn(),
  },
  stage: {
    stageChannelId: 'voice-a' as string | null,
    stageMediaItems: [] as Array<{
      id: string
      generation: number
      userId: string
      kind: 'camera' | 'screen' | 'avatar'
      isLocal: boolean
      live: boolean
      pending?: boolean
    }>,
    viewedRemoteScreenIds: [] as string[],
    focusedMediaId: null as string | null,
    setFocusedMediaId: vi.fn(),
    stageFocusNonce: 0,
    watchParticipantScreenShare: vi.fn(),
    stageMediaFilters: {
      showOwnStream: true,
      showRemoteStreams: true,
      showParticipantsWithoutMedia: true,
    },
    setStageMediaFilters: vi.fn(),
    setStageMediaSubscribed: vi.fn(),
    stageFullscreen: false,
    toggleStageFullscreen: vi.fn(),
    activityLauncherOpen: false,
    setActivityLauncherOpen: vi.fn(),
  },
  activity: {
    instance: null as null | {
      id: string
      application_id: string
      channel_id: string
      owner_id: string
      participant_ids: string[]
      revision: number
      state: unknown
      created_at: string
      expires_at: number
    },
    generation: 0,
    error: null,
    transport: 'connected' as const,
  },
  activityHook: vi.fn(),
  uiFeatures: { channelActivities: true },
  participants: {} as Record<string, Array<{ id: string }>>,
}))

const users = {
  local: { _id: 'local', username: 'Local' } as User,
  alice: { _id: 'alice', username: 'Alice' } as User,
  bob: { _id: 'bob', username: 'Bob' } as User,
}

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({ user: users.local }),
}))

vi.mock('#/features/voice/voice-session-context', () => ({
  useVoiceSession: () => testState.session,
}))

vi.mock('#/features/voice/voice-stage-context', () => ({
  useVoiceStage: () => testState.stage,
}))

vi.mock('#/features/activities/use-channel-activity', () => ({
  useChannelActivity: (channelId: string, enabled: boolean) =>
    testState.activityHook(channelId, enabled),
}))

vi.mock('#/lib/ui-feature-flags', () => ({
  uiFeatureFlags: testState.uiFeatures,
}))

vi.mock('#/features/activities/channel-activity-client', () => ({
  channelActivityClient: {
    sync: vi.fn(),
  },
}))

vi.mock('#/features/sync/sync-store', () => ({
  useSyncStore: (selector: (state: unknown) => unknown) =>
    selector({ users, servers: {}, members: {} }),
}))

vi.mock('#/features/sync/voice-selectors', () => ({
  getChannelVoiceParticipants: (_state: unknown, channelId: string) =>
    testState.participants[channelId] ?? [],
  useChannelVoiceParticipantsWithLocalOverride: (
    _channelId: string,
    participants: Array<{ id: string }>,
  ) => participants,
}))

vi.mock('#/features/voice/voice-mic-status', () => ({
  isVoiceSessionInChannel: (
    session: { channelId: string | null },
    channelId: string,
  ) => session.channelId === channelId,
}))

vi.mock('#/features/voice/use-voice-stage-chrome-visible', () => ({
  useVoiceStageChromeVisible: () => ({
    stageRef: { current: null },
    chromeVisible: true,
  }),
  voiceStageChromeMotion: () => '',
}))

vi.mock('#/components/icons/voice-channel-icon', () => ({
  VoiceChannelIcon: () => <span />,
}))

vi.mock('#/components/voice/voice-stage-grid', () => ({
  VoiceStageGrid: ({
    items,
    renderTile,
  }: {
    items: Array<{ id: string }>
    renderTile: (item: { id: string }, variant: 'grid') => ReactNode
  }) => (
    <div data-testid="media-grid">
      {items.map((item) => (
        <div key={item.id}>
          {item.id}
          {renderTile(item, 'grid')}
        </div>
      ))}
    </div>
  ),
}))

vi.mock('#/components/voice/voice-stage-activity-tile', () => ({
  VoiceStageActivityTile: ({ item }: { item: { id: string } }) => (
    <div data-testid="activity-tile">{item.id}</div>
  ),
}))

vi.mock('#/features/activities/channel-activity-panel', () => ({
  ChannelActivityLauncher: () => (
    <div data-testid="activity-launcher">Activity launcher</div>
  ),
}))

vi.mock('#/components/voice/voice-stage-avatar-roster', () => ({
  VoiceStageAvatarRoster: ({
    participants,
  }: {
    participants: Array<{ id: string }>
  }) => (
    <div data-testid="avatar-roster">
      {participants.map((participant) => participant.id).join(',')}
    </div>
  ),
}))

vi.mock('#/components/voice/voice-stage-controls', () => ({
  VoiceStageControls: ({ connecting }: { connecting: boolean }) => (
    <div data-testid="voice-controls" data-connecting={String(connecting)} />
  ),
  VoiceStageFullscreenButton: () => null,
  VoiceStagePopoutButton: () => null,
}))

vi.mock('#/components/voice/voice-stage-focus-stage', () => ({
  VoiceStageFocusStage: () => <div data-testid="focus-stage" />,
}))

vi.mock('#/components/voice/voice-stage-media-tile', () => ({
  StageMediaTile: () => null,
}))

function voiceChannel(id: string, name: string): Channel {
  return {
    _id: id,
    channel_type: 'VoiceChannel',
    server: 'server',
    name,
  } as unknown as Channel
}

function renderStage(channel: Channel) {
  return render(
    <VoiceStageView
      channel={channel}
      title={'name' in channel ? channel.name : channel._id}
      chatOpen={false}
      onToggleChat={() => undefined}
    />,
  )
}

function getEmbeddedStageSurface(container: HTMLElement): HTMLElement {
  const surface = container.querySelector<HTMLElement>(
    '[data-voice-stage-surface="embedded"]',
  )
  if (!surface) throw new Error('Embedded VoiceStage surface was not rendered')
  return surface
}

function expectFixedBlackStageSurface(surface: HTMLElement) {
  expect(surface.classList.contains('bg-black')).toBe(true)
  expect(surface.classList.contains('gradient-surface-content')).toBe(false)
  expect(surface.classList.contains('gradient-stage-empty')).toBe(false)
}

describe('VoiceStageView channel media scope', () => {
  beforeEach(() => {
    testState.session.channelId = 'voice-a'
    testState.session.status = 'connected'
    testState.stage.stageChannelId = 'voice-a'
    testState.stage.activityLauncherOpen = false
    testState.uiFeatures.channelActivities = true
    testState.activityHook.mockReset()
    testState.activityHook.mockImplementation(() => testState.activity)
    testState.activity.instance = null
    testState.activity.generation = 0
    testState.stage.stageMediaItems = [
      {
        id: 'alice:camera',
        userId: 'alice',
        kind: 'camera',
        isLocal: false,
        live: true,
      },
    ]
    testState.participants = {
      'voice-a': [{ id: 'alice' }],
      'voice-b': [{ id: 'bob' }],
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('does not carry active channel A media into an opened channel B', () => {
    const { rerender } = renderStage(voiceChannel('voice-a', 'A'))

    expect(screen.getByTestId('media-grid').textContent).toBe('alice:camera')

    const channelB = voiceChannel('voice-b', 'B')
    rerender(
      <VoiceStageView
        channel={channelB}
        title="B"
        chatOpen={false}
        onToggleChat={() => undefined}
      />,
    )

    expect(screen.queryByTestId('media-grid')).toBeNull()
    expect(screen.getByText('Bob сейчас в голосовом чате')).toBeTruthy()
    expect(screen.queryByText('alice:camera')).toBeNull()
  })

  it('keeps the stage surface black across media and empty states', () => {
    const channel = voiceChannel('voice-a', 'A')
    const { container, rerender } = renderStage(channel)
    const surface = getEmbeddedStageSurface(container)

    expectFixedBlackStageSurface(surface)

    testState.session.channelId = null
    testState.session.status = 'idle'
    testState.stage.stageChannelId = null
    testState.stage.stageMediaItems = []
    testState.participants = { 'voice-a': [] }

    rerender(
      <VoiceStageView
        channel={channel}
        title="A"
        chatOpen={false}
        onToggleChat={() => undefined}
      />,
    )

    expect(getEmbeddedStageSurface(container)).toBe(surface)
    expectFixedBlackStageSurface(surface)
    expect(screen.getByText('В канале никого нет')).toBeTruthy()
  })

  it('switches remote participant previews when no RTC media scope is active', () => {
    testState.session.channelId = null
    testState.session.status = 'idle'
    testState.stage.stageChannelId = null
    testState.stage.stageMediaItems = []

    const { rerender } = renderStage(voiceChannel('voice-a', 'A'))
    expect(screen.getByText('Alice сейчас в голосовом чате')).toBeTruthy()

    const channelB = voiceChannel('voice-b', 'B')
    rerender(
      <VoiceStageView
        channel={channelB}
        title="B"
        chatOpen={false}
        onToggleChat={() => undefined}
      />,
    )

    expect(screen.queryByText('Alice сейчас в голосовом чате')).toBeNull()
    expect(screen.getByText('Bob сейчас в голосовом чате')).toBeTruthy()
  })

  it('keeps the connecting intent preview visible in its target channel', () => {
    testState.session.status = 'connecting'
    testState.stage.stageMediaItems = [
      {
        id: 'local:avatar',
        userId: 'local',
        kind: 'avatar',
        isLocal: true,
        live: false,
        pending: true,
      },
    ]

    renderStage(voiceChannel('voice-a', 'A'))

    expect(screen.getByTestId('media-grid').textContent).toBe('local:avatar')
    expect(screen.getByTestId('voice-controls').dataset.connecting).toBe('true')
  })

  it('renders a running Activity as a stage tile without the old header button', () => {
    testState.activity.instance = {
      id: 'activity-1',
      generation: 1,
      application_id: 'syrnike13.syrnik-race',
      channel_id: 'voice-a',
      owner_id: 'local',
      participant_ids: ['local'],
      revision: 1,
      state: {},
      created_at: '2026-07-20T00:00:00Z',
      expires_at: Date.parse('2026-07-20T02:00:00Z'),
    }

    renderStage(voiceChannel('voice-a', 'A'))

    expect(screen.getByTestId('activity-tile').textContent).toBe(
      'channel-activity:activity-1',
    )
    expect(
      screen.queryByRole('button', { name: 'Открыть Активности' }),
    ).toBeNull()
  })

  it('removes a cached Activity tile after leaving its voice channel', () => {
    testState.activity.instance = {
      id: 'activity-1',
      generation: 1,
      application_id: 'syrnike13.syrnik-race',
      channel_id: 'voice-a',
      owner_id: 'local',
      participant_ids: ['local'],
      revision: 1,
      state: {},
      created_at: '2026-07-20T00:00:00Z',
      expires_at: Date.parse('2026-07-20T02:00:00Z'),
    }
    testState.activity.generation = 1

    const { rerender } = renderStage(voiceChannel('voice-a', 'A'))
    expect(screen.getByTestId('activity-tile')).toBeTruthy()

    testState.session.status = 'idle'
    rerender(
      <VoiceStageView
        channel={voiceChannel('voice-a', 'A')}
        title="A"
        chatOpen={false}
        onToggleChat={() => undefined}
      />,
    )
    expect(screen.queryByTestId('activity-tile')).toBeNull()
  })

  it('hides Activity UI and disables its subscription outside nightly builds', () => {
    testState.uiFeatures.channelActivities = false
    testState.stage.activityLauncherOpen = true
    testState.activity.instance = {
      id: 'activity-1',
      generation: 1,
      application_id: 'syrnike13.syrnik-race',
      channel_id: 'voice-a',
      owner_id: 'local',
      participant_ids: ['local'],
      revision: 1,
      state: {},
      created_at: '2026-07-20T00:00:00Z',
      expires_at: Date.parse('2026-07-20T02:00:00Z'),
    }

    renderStage(voiceChannel('voice-a', 'A'))

    expect(testState.activityHook).toHaveBeenCalledWith('voice-a', false)
    expect(screen.queryByTestId('activity-tile')).toBeNull()
    expect(screen.queryByTestId('activity-launcher')).toBeNull()
  })

  it('renders the empty channel title and joins from the centered action', () => {
    testState.session.channelId = null
    testState.session.status = 'idle'
    testState.session.join.mockResolvedValue(true)
    testState.stage.stageChannelId = null
    testState.stage.stageMediaItems = []
    testState.participants = { 'voice-a': [] }

    renderStage(voiceChannel('voice-a', 'Тихая комната'))

    expect(
      screen.getByRole('heading', { level: 2, name: 'Тихая комната' }),
    ).toBeTruthy()
    expect(screen.getByText('В канале никого нет')).toBeTruthy()
    expect(screen.queryByText('Никого нет в канале')).toBeNull()
    expect(screen.queryByTestId('voice-controls')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    expect(testState.session.join).toHaveBeenCalledWith('voice-a')
  })

  it('joins from the centered preview when other participants are present', () => {
    testState.session.channelId = null
    testState.session.status = 'idle'
    testState.session.join.mockResolvedValue(true)
    testState.stage.stageChannelId = null
    testState.stage.stageMediaItems = []
    testState.participants = {
      'voice-a': [{ id: 'alice' }, { id: 'bob' }],
    }

    renderStage(voiceChannel('voice-a', 'Основной'))

    expect(
      screen.getByRole('heading', { level: 2, name: 'Основной' }),
    ).toBeTruthy()
    expect(
      screen.getByText('Alice и ещё 1 участник сейчас в голосовом чате'),
    ).toBeTruthy()
    expect(screen.queryByTestId('voice-controls')).toBeNull()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Присоединиться к голосовому каналу',
      }),
    )
    expect(testState.session.join).toHaveBeenCalledWith('voice-a')
  })
})
