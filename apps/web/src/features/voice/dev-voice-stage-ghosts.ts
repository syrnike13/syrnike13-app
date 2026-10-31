import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { User } from '@syrnike13/api-types'

import type { UserVoiceState } from '@syrnike13/client/sync/voice-types'
import type {
  VoiceStageMediaItem,
  VoiceStageMediaTrack,
} from '#/features/voice/voice-context'
import type { NativeVideoTrackAdapter } from '#/features/voice/native-video-registry'
import { stageMediaItemId } from '#/features/voice/voice-stage-media'

export type DevVoiceGhostProfile = {
  id: string
  username: string
  displayName: string
}

export type DevVoiceGhostStatus = {
  muted: boolean
  deafened: boolean
  demo: boolean
}

export type DevVoiceGhostsState = {
  activeIds: readonly string[]
  statuses: Readonly<Record<string, DevVoiceGhostStatus>>
  speakingPulse: boolean
}

export const DEV_VOICE_GHOST_PROFILES: readonly DevVoiceGhostProfile[] = [
  { id: 'dev-ghost-nova', username: 'nova', displayName: 'Nova' },
  { id: 'dev-ghost-mira', username: 'mira', displayName: 'Mira' },
  { id: 'dev-ghost-kite', username: 'kite', displayName: 'Kite' },
  { id: 'dev-ghost-echo', username: 'echo', displayName: 'Echo' },
  { id: 'dev-ghost-rook', username: 'rook', displayName: 'Rook' },
  { id: 'dev-ghost-luma', username: 'luma', displayName: 'Luma' },
  { id: 'dev-ghost-sable', username: 'sable', displayName: 'Sable' },
  { id: 'dev-ghost-iris', username: 'iris', displayName: 'Iris' },
]

const GHOST_IDS = DEV_VOICE_GHOST_PROFILES.map((profile) => profile.id)
const GHOST_ACCENTS = [
  '#818cf8',
  '#34d399',
  '#f472b6',
  '#fbbf24',
  '#38bdf8',
  '#c084fc',
  '#fb7185',
  '#a3e635',
]

const DEFAULT_STATUSES: Record<string, DevVoiceGhostStatus> = {
  'dev-ghost-nova': { muted: false, deafened: false, demo: true },
  'dev-ghost-mira': { muted: true, deafened: false, demo: false },
  'dev-ghost-kite': { muted: false, deafened: false, demo: false },
  'dev-ghost-echo': { muted: true, deafened: true, demo: false },
  'dev-ghost-rook': { muted: false, deafened: false, demo: false },
  'dev-ghost-luma': { muted: false, deafened: false, demo: false },
  'dev-ghost-sable': { muted: true, deafened: true, demo: false },
  'dev-ghost-iris': { muted: true, deafened: false, demo: false },
}

const GHOST_JOINED_AT = Object.fromEntries(
  GHOST_IDS.map((id, index) => [id, Date.now() - (index + 1) * 7 * 60_000]),
) as Record<string, number>

const GHOST_USERS: Record<string, User> = Object.fromEntries(
  DEV_VOICE_GHOST_PROFILES.map((profile) => [
    profile.id,
    {
      _id: profile.id,
      username: profile.username,
      discriminator: '0001',
      display_name: profile.displayName,
      avatar: null,
      relationship: 'None',
      online: true,
      status: null,
    } satisfies User,
  ]),
)

function createDefaultState(): DevVoiceGhostsState {
  return {
    activeIds: [...GHOST_IDS],
    statuses: Object.fromEntries(
      Object.entries(DEFAULT_STATUSES).map(([id, status]) => [
        id,
        { ...status },
      ]),
    ),
    speakingPulse: true,
  }
}

let ghostsState = createDefaultState()
const listeners = new Set<() => void>()

function emitGhostsChange() {
  for (const listener of listeners) listener()
}

function updateGhostsState(
  updater: (state: DevVoiceGhostsState) => DevVoiceGhostsState,
) {
  ghostsState = updater(ghostsState)
  emitGhostsChange()
}

export function subscribeDevVoiceGhosts(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getDevVoiceGhostsSnapshot() {
  return ghostsState
}

export function useDevVoiceGhostsState() {
  return useSyncExternalStore(
    subscribeDevVoiceGhosts,
    getDevVoiceGhostsSnapshot,
    getDevVoiceGhostsSnapshot,
  )
}

export function isDevVoiceGhostsModified(state: DevVoiceGhostsState) {
  if (
    state.activeIds.length !== GHOST_IDS.length ||
    !state.speakingPulse
  ) {
    return true
  }
  return GHOST_IDS.some((id) => {
    const current = state.statuses[id]
    const initial = DEFAULT_STATUSES[id]
    return (
      !current ||
      current.muted !== initial.muted ||
      current.deafened !== initial.deafened ||
      current.demo !== initial.demo
    )
  })
}

export function setGhostPresent(id: string, present: boolean) {
  updateGhostsState((state) => {
    const active = state.activeIds.includes(id)
    if (present === active) return state
    return {
      ...state,
      activeIds: present
        ? [...state.activeIds, id]
        : state.activeIds.filter((candidate) => candidate !== id),
    }
  })
}

export function setGhostMuted(id: string, muted: boolean) {
  updateGhostsState((state) => ({
    ...state,
    statuses: {
      ...state.statuses,
      [id]: { ...state.statuses[id], muted },
    },
  }))
}

export function setGhostDeafened(id: string, deafened: boolean) {
  updateGhostsState((state) => {
    const current = state.statuses[id]
    return {
      ...state,
      statuses: {
        ...state.statuses,
        [id]: {
          ...current,
          deafened,
          muted: deafened ? true : current.muted,
        },
      },
    }
  })
}

export function setGhostDemo(id: string, demo: boolean) {
  updateGhostsState((state) => ({
    ...state,
    statuses: {
      ...state.statuses,
      [id]: { ...state.statuses[id], demo },
    },
  }))
}

export function setAllGhostsMuted(muted: boolean) {
  updateGhostsState((state) => ({
    ...state,
    statuses: Object.fromEntries(
      Object.entries(state.statuses).map(([id, status]) => [
        id,
        state.activeIds.includes(id) ? { ...status, muted } : status,
      ]),
    ),
  }))
}

export function setAllGhostsDeafened(deafened: boolean) {
  updateGhostsState((state) => ({
    ...state,
    statuses: Object.fromEntries(
      Object.entries(state.statuses).map(([id, status]) => [
        id,
        state.activeIds.includes(id)
          ? {
              ...status,
              deafened,
              muted: deafened ? true : status.muted,
            }
          : status,
      ]),
    ),
  }))
}

export function setGhostSpeakingPulse(speakingPulse: boolean) {
  updateGhostsState((state) => ({ ...state, speakingPulse }))
}

export function resetDevVoiceGhosts() {
  ghostsState = createDefaultState()
  emitGhostsChange()
}

export type DevVoiceStageGhosts = {
  participants: readonly UserVoiceState[]
  users: Record<string, User>
  mediaItems: readonly VoiceStageMediaItem[]
  speakingUserIds: ReadonlySet<string>
}

const EMPTY_IDS: readonly string[] = []
const EMPTY_SET: ReadonlySet<string> = new Set()
const EMPTY_PARTICIPANTS: readonly UserVoiceState[] = []
const EMPTY_MEDIA_ITEMS: readonly VoiceStageMediaItem[] = []
const EMPTY_GHOSTS: DevVoiceStageGhosts = {
  participants: EMPTY_PARTICIPANTS,
  users: {},
  mediaItems: EMPTY_MEDIA_ITEMS,
  speakingUserIds: EMPTY_SET,
}

/** Layout-only fake participants for reviewing the voice stage in dev. */
export function useDevVoiceStageGhosts({
  enabled,
}: {
  enabled: boolean
}): DevVoiceStageGhosts {
  const state = useDevVoiceGhostsState()
  const active =
    import.meta.env.DEV &&
    // Vitest runs in development mode; keep fake participants out of tests.
    import.meta.env.MODE !== 'test' &&
    enabled
  const activeIds = active ? state.activeIds : EMPTY_IDS
  const demoIdsKey = active
    ? activeIds.filter((id) => state.statuses[id]?.demo).join('|')
    : ''
  const speakingCandidates = active && state.speakingPulse
    ? activeIds.filter((id) => {
        const status = state.statuses[id]
        return status && !status.muted && !status.deafened
      })
    : EMPTY_IDS
  const speakingCandidatesKey = speakingCandidates.join('|')
  const [speakingIndex, setSpeakingIndex] = useState(0)

  useEffect(() => {
    if (!active || !state.speakingPulse || !speakingCandidatesKey) return
    const count = speakingCandidatesKey.split('|').length
    const timer = window.setInterval(() => {
      setSpeakingIndex((index) => (index + 1) % count)
    }, 1600)
    return () => window.clearInterval(timer)
  }, [active, speakingCandidatesKey, state.speakingPulse])

  useEffect(() => {
    setSpeakingIndex(0)
  }, [speakingCandidatesKey])

  const speakingUserIds = useMemo<ReadonlySet<string>>(() => {
    if (!active || !state.speakingPulse || !speakingCandidatesKey) {
      return EMPTY_SET
    }
    const ids = speakingCandidatesKey.split('|')
    return new Set([ids[speakingIndex % ids.length]])
  }, [
    active,
    speakingCandidatesKey,
    speakingIndex,
    state.speakingPulse,
  ])

  const participants = useMemo<readonly UserVoiceState[]>(() => {
    if (!active) return EMPTY_PARTICIPANTS
    const demoOwnerId = demoIdsKey ? demoIdsKey.split('|')[0] : null
    return activeIds.map((id, index) => {
      const status = state.statuses[id]
      return {
        id,
        joined_at: GHOST_JOINED_AT[id] ?? 0,
        self_mute: status?.muted ?? false,
        self_deaf: status?.deafened ?? false,
        server_muted: false,
        server_deafened: false,
        screensharing: status?.demo ?? false,
        camera: false,
        watching:
          demoOwnerId && id !== demoOwnerId && index < 4
            ? [demoOwnerId]
            : [],
        version: 1,
      }
    })
  }, [active, activeIds, demoIdsKey, state.statuses])

  const mediaItems = useMemo<readonly VoiceStageMediaItem[]>(() => {
    if (!active) return EMPTY_MEDIA_ITEMS
    const demoIds = demoIdsKey ? demoIdsKey.split('|') : []
    const screenItems = demoIds.map((id, index) => {
      const profile = DEV_VOICE_GHOST_PROFILES.find((item) => item.id === id)
      return createDevGhostScreenItem(
        id,
        profile?.displayName ?? 'Ghost',
        index,
      )
    })
    const avatarItems = activeIds.map(
      (id): VoiceStageMediaItem => ({
        id: stageMediaItemId(id, 'avatar'),
        userId: id,
        kind: 'avatar',
        isLocal: false,
        live: true,
      }),
    )
    return [...screenItems, ...avatarItems]
  }, [active, activeIds, demoIdsKey])

  return useMemo(
    () =>
      active
        ? {
            participants,
            users: GHOST_USERS,
            mediaItems,
            speakingUserIds,
          }
        : EMPTY_GHOSTS,
    [active, mediaItems, participants, speakingUserIds],
  )
}

type DevGhostCanvasOptions = {
  fit?: 'contain' | 'cover'
  onFrame?: () => void
}

const DEMO_WIDTH = 1280
const DEMO_HEIGHT = 720

function createDevGhostScreenItem(
  userId: string,
  displayName: string,
  accentIndex: number,
): VoiceStageMediaItem {
  return {
    id: stageMediaItemId(userId, 'screen'),
    userId,
    kind: 'screen',
    source: 'screen',
    track: createDevGhostScreenTrack(
      displayName,
      GHOST_ACCENTS[accentIndex % GHOST_ACCENTS.length],
    ),
    publication: {
      backend: 'native',
      source: 'screen',
      isMuted: false,
      isSubscribed: true,
    },
    isLocal: false,
    subscribed: true,
    live: true,
  }
}

function createDevGhostScreenTrack(
  displayName: string,
  accent: string,
): VoiceStageMediaTrack {
  const adapter = {
    attachCanvas(
      canvas: HTMLCanvasElement,
      onSizeChange?: (size: { width: number; height: number }) => void,
      options?: DevGhostCanvasOptions,
    ) {
      canvas.width = DEMO_WIDTH
      canvas.height = DEMO_HEIGHT
      paintDevGhostDemo(canvas, 0, displayName, accent)
      onSizeChange?.({ width: DEMO_WIDTH, height: DEMO_HEIGHT })
      options?.onFrame?.()

      let frame = 0
      const timer = window.setInterval(() => {
        paintDevGhostDemo(canvas, (frame += 1), displayName, accent)
      }, 80)

      return () => window.clearInterval(timer)
    },
  }

  return {
    backend: 'native',
    track: adapter as unknown as NativeVideoTrackAdapter,
  }
}

function paintDevGhostDemo(
  canvas: HTMLCanvasElement,
  frame: number,
  displayName: string,
  accent: string,
) {
  const context = canvas.getContext('2d')
  if (!context) return

  const width = canvas.width
  const height = canvas.height
  const background = context.createLinearGradient(0, 0, width, height)
  background.addColorStop(0, '#171a23')
  background.addColorStop(0.55, '#1d2333')
  background.addColorStop(1, '#11141c')
  context.fillStyle = background
  context.fillRect(0, 0, width, height)

  context.fillStyle = 'rgba(255, 255, 255, 0.06)'
  context.fillRect(0, 0, width, 52)
  for (let index = 0; index < 3; index += 1) {
    context.beginPath()
    context.arc(28 + index * 22, 26, 6, 0, Math.PI * 2)
    context.fillStyle =
      index === 0 ? '#f87171' : index === 1 ? '#fbbf24' : '#4ade80'
    context.fill()
  }

  context.fillStyle = 'rgba(255, 255, 255, 0.04)'
  context.fillRect(0, 52, 232, height - 52)
  for (let index = 0; index < 8; index += 1) {
    context.fillStyle = 'rgba(255, 255, 255, 0.12)'
    context.fillRect(
      24,
      86 + index * 42,
      index === 2 ? 120 : 80 + (index % 3) * 24,
      8,
    )
  }

  context.fillStyle = 'rgba(255, 255, 255, 0.08)'
  context.fillRect(268, 88, 64, 20)
  context.fillStyle = '#fca5a5'
  context.font = '600 12px "Segoe UI", sans-serif'
  context.fillText('LIVE DEMO', 280, 102)

  context.fillStyle = '#f4f4f5'
  context.font = '700 42px "Segoe UI", sans-serif'
  context.fillText(`${displayName} is presenting`, 268, 158)
  context.fillStyle = 'rgba(244, 244, 245, 0.62)'
  context.font = '400 19px "Segoe UI", sans-serif'
  context.fillText(
    'Fake screen share for layout and motion checks',
    268,
    194,
  )

  context.fillStyle = 'rgba(255, 255, 255, 0.05)'
  context.fillRect(268, 224, 566, 292)
  context.strokeStyle = 'rgba(255, 255, 255, 0.09)'
  context.lineWidth = 2
  context.strokeRect(268, 224, 566, 292)

  for (let index = 0; index < 12; index += 1) {
    const barHeight =
      46 + (Math.sin(frame / 7 + index * 0.8) * 0.5 + 0.5) * 150
    context.fillStyle =
      index % 3 === 0 ? `${accent}dd` : 'rgba(255, 255, 255, 0.18)'
    context.fillRect(300 + index * 42, 470 - barHeight, 22, barHeight)
  }

  context.fillStyle = 'rgba(255, 255, 255, 0.05)'
  context.fillRect(866, 224, 350, 292)
  for (let index = 0; index < 7; index += 1) {
    context.fillStyle =
      index % 2 === 0
        ? `${accent}99`
        : 'rgba(244, 244, 245, 0.18)'
    context.fillRect(892, 258 + index * 32, 160 + (index % 4) * 34, 10)
  }

  const pointerX = 520 + Math.sin(frame / 18) * 210
  const pointerY = 360 + Math.cos(frame / 23) * 110
  context.beginPath()
  context.arc(pointerX, pointerY, 16, 0, Math.PI * 2)
  context.fillStyle = `${accent}33`
  context.fill()
  context.beginPath()
  context.arc(pointerX, pointerY, 6, 0, Math.PI * 2)
  context.fillStyle = accent
  context.fill()

  const progress = (Math.sin(frame / 45) * 0.5 + 0.5) * 0.8 + 0.1
  context.fillStyle = 'rgba(255, 255, 255, 0.08)'
  context.fillRect(268, 548, 948, 8)
  context.fillStyle = `${accent}dd`
  context.fillRect(268, 548, 948 * progress, 8)
}
