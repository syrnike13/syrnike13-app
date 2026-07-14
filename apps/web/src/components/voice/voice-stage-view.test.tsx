// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
      userId: string
      kind: 'camera' | 'screen' | 'avatar'
      isLocal: boolean
      live: boolean
      pending?: boolean
    }>,
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
  },
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

vi.mock('#/features/sync/sync-store', () => ({
  useSyncStore: (selector: (state: unknown) => unknown) =>
    selector({ users, servers: {}, members: {} }),
}))

vi.mock('#/features/sync/voice-selectors', () => ({
  getChannelVoiceParticipants: (
    _state: unknown,
    channelId: string,
  ) => testState.participants[channelId] ?? [],
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
  VoiceStageGrid: ({ items }: { items: Array<{ id: string }> }) => (
    <div data-testid="media-grid">{items.map((item) => item.id).join(',')}</div>
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

describe('VoiceStageView channel media scope', () => {
  beforeEach(() => {
    testState.session.channelId = 'voice-a'
    testState.session.status = 'connected'
    testState.stage.stageChannelId = 'voice-a'
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
    expect(screen.getByTestId('avatar-roster').textContent).toBe('bob')
    expect(screen.queryByText('alice:camera')).toBeNull()
  })

  it('switches avatar rosters when no RTC media scope is active', () => {
    testState.session.channelId = null
    testState.session.status = 'idle'
    testState.stage.stageChannelId = null
    testState.stage.stageMediaItems = []

    const { rerender } = renderStage(voiceChannel('voice-a', 'A'))
    expect(screen.getByTestId('avatar-roster').textContent).toBe('alice')

    const channelB = voiceChannel('voice-b', 'B')
    rerender(
      <VoiceStageView
        channel={channelB}
        title="B"
        chatOpen={false}
        onToggleChat={() => undefined}
      />,
    )

    expect(screen.getByTestId('avatar-roster').textContent).toBe('bob')
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
})
