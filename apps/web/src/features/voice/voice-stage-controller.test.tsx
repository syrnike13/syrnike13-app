// @vitest-environment jsdom

import { useEffect } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Room } from 'livekit-client'

import type { NativeMediaState } from '#/features/voice/native-media-coordinator'
import { useVoiceStageController } from '#/features/voice/voice-stage-controller'
import type { VoiceStageMediaItem } from '#/features/voice/voice-context'
import type { VoiceStatus } from '#/features/voice/voice-mic-status'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('useVoiceStageController', () => {
  it('does not republish unchanged stage media after parent callback identity changes', async () => {
    const snapshots: VoiceStageMediaItem[][] = []
    const room = {
      localParticipant: {
        identity: '507f1f77bcf86cd799439011',
        trackPublications: new Map(),
      },
      remoteParticipants: new Map(),
    } as unknown as Room
    const roomRef = { current: room }
    const nativeMediaStateRef = {
      current: { screen: { status: 'idle' } } as NativeMediaState,
    }
    const stoppedNativeScreenIdentityRef = { current: null }
    const nativeScreenShareRef = { current: null }

    function Harness({ revision }: { revision: number }) {
      const stage = useVoiceStageController({
        authUserId: '507f1f77bcf86cd799439011',
        channelId: 'voice-a',
        status: 'connected' as VoiceStatus,
        join: vi.fn(),
        roomRef,
        nativeMediaStateRef,
        stoppedNativeScreenIdentityRef,
        nativeScreenShareRef,
        stopNativeScreenShare: vi.fn(),
        setScreenShareEnabled: vi.fn(),
        syncRoomParticipants: vi.fn(),
        onNativeScreenPublicationLost: () => {
          void revision
        },
        logStageSyncDebug: vi.fn(),
      })

      useEffect(() => {
        snapshots.push(stage.stageMediaItems)
      }, [stage.stageMediaItems])

      return null
    }

    const view = render(<Harness revision={0} />)
    const afterMountSnapshotCount = snapshots.length

    view.rerender(<Harness revision={1} />)

    expect(snapshots).toHaveLength(afterMountSnapshotCount)
  })
})
