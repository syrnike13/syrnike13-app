import { useEffect, useMemo, useRef } from 'react'
import {
  EMPTY_DESKTOP_OVERLAY_SNAPSHOT,
  desktopOverlaySnapshotsEqual,
  normalizeDesktopOverlaySnapshot,
  type DesktopOverlaySnapshot,
} from '@syrnike13/platform'

import { useAuth } from '#/features/auth/auth-context'
import { getChannelLabel } from '#/features/sync/channel-label'
import { useSyncStore } from '#/features/sync/sync-store'
import type { SyncState } from '#/features/sync/types'
import type { UserVoiceState } from '#/features/sync/voice-types'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { usePlatform } from '#/platform/use-platform'

import { buildVoiceOverlaySnapshot } from './voice-overlay-snapshot'

const EMPTY_PARTICIPANTS: UserVoiceState[] = []
const EMPTY_PARTICIPANTS_BY_USER: Record<string, UserVoiceState> = {}

export function selectDesktopOverlayChannel(
  state: Pick<SyncState, 'channels'>,
  channelId: string | null,
) {
  return channelId ? state.channels[channelId] : undefined
}

export function selectDesktopOverlayParticipants(
  state: Pick<SyncState, 'voiceParticipants'>,
  channelId: string | null,
) {
  return channelId
    ? (state.voiceParticipants[channelId] ?? EMPTY_PARTICIPANTS_BY_USER)
    : EMPTY_PARTICIPANTS_BY_USER
}

export function createDesktopOverlaySnapshotPublisher(
  send: (snapshot: DesktopOverlaySnapshot) => Promise<unknown>,
  onError: (error: unknown) => void,
) {
  let delivered: DesktopOverlaySnapshot | null = null
  let pending: DesktopOverlaySnapshot | null = null
  let inFlight = false
  let scheduled = false
  let closing = false
  let closed = false

  const schedule = () => {
    if (scheduled || inFlight || closed) return
    scheduled = true
    queueMicrotask(flush)
  }

  const flush = () => {
    scheduled = false
    if (inFlight || closed || !pending) return
    const next = pending
    pending = null
    if (delivered && desktopOverlaySnapshotsEqual(delivered, next)) {
      if (closing) closed = true
      return
    }

    inFlight = true
    void send(next)
      .then(() => {
        delivered = next
      })
      .catch(onError)
      .finally(() => {
        inFlight = false
        if (closing && !pending) closed = true
        else if (pending) schedule()
      })
  }

  return {
    publish(snapshot: DesktopOverlaySnapshot) {
      if (closing || closed) return
      const normalized = normalizeDesktopOverlaySnapshot(snapshot)
      const latest = pending ?? delivered
      if (latest && desktopOverlaySnapshotsEqual(latest, normalized)) {
        return
      }
      pending = normalized
      schedule()
    },
    close() {
      if (closing || closed) return
      closing = true
      pending = EMPTY_DESKTOP_OVERLAY_SNAPSHOT
      schedule()
    },
  }
}

export function DesktopOverlayPublisher() {
  const auth = useAuth()
  const voice = useVoiceSession()
  const { desktop, os } = usePlatform()
  const users = useSyncStore((state) => state.users)
  const channel = useSyncStore((state) =>
    selectDesktopOverlayChannel(state, voice.channelId),
  )
  const participantsByUser = useSyncStore((state) =>
    selectDesktopOverlayParticipants(state, voice.channelId),
  )
  const participants = useMemo(
    () =>
      voice.channelId
        ? Object.values(participantsByUser)
        : EMPTY_PARTICIPANTS,
    [participantsByUser, voice.channelId],
  )
  const channelLabel = useMemo(
    () =>
      !voice.channelId
        ? null
        : channel && auth.user
          ? getChannelLabel(channel, users, auth.user._id)
          : 'Голосовой канал',
    [auth.user, channel, users, voice.channelId],
  )

  const snapshot = useMemo(
    () =>
      buildVoiceOverlaySnapshot({
        channelId: voice.channelId,
        channelLabel,
        participants,
        speakingUserIds: voice.speakingUserIds,
        users,
      }),
    [
      channelLabel,
      participants,
      users,
      voice.channelId,
      voice.speakingUserIds,
    ],
  )

  const publisherRef = useRef<ReturnType<
    typeof createDesktopOverlaySnapshotPublisher
  > | null>(null)

  useEffect(() => {
    if (!desktop || os !== 'win32') return
    const publisher = createDesktopOverlaySnapshotPublisher(
      (nextSnapshot) => desktop.overlay.setSnapshot(nextSnapshot),
      (error) => console.error('[desktop-overlay] snapshot failed', error),
    )
    publisherRef.current = publisher
    return () => {
      if (publisherRef.current === publisher) publisherRef.current = null
      publisher.close()
    }
  }, [desktop, os])

  useEffect(() => {
    publisherRef.current?.publish(snapshot)
  }, [desktop, os, snapshot])

  return null
}
