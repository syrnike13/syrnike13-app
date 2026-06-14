import {
  DEFAULT_SOUND_AUTHOR_PACK_ID,
  SOUND_AUTHOR_PACK_IDS,
  type SoundAuthorPackId,
} from '@syrnike13/platform'

import { UI_SOUND_EVENTS, type SoundEventId } from './sound-events'

export { DEFAULT_SOUND_AUTHOR_PACK_ID, UI_SOUND_EVENTS }

export const DEFAULT_EASTER_CHANCE = 0.0025

export type SoundPackKind = 'author' | 'event'

export type SoundClip = {
  src: string
  volume?: number
}

const SOUND_EVENT_PACK_IDS = [] as const
export type SoundEventPackId = (typeof SOUND_EVENT_PACK_IDS)[number]

export type SoundPack = {
  id: SoundAuthorPackId | SoundEventPackId
  label: string
  kind: SoundPackKind
  sounds: Partial<Record<SoundEventId, SoundClip>>
  easter: Partial<Record<SoundEventId, SoundClip>>
}

export type ResolvedSoundClip = SoundClip & {
  eventId: SoundEventId
  packId: SoundPack['id']
  packKind: SoundPackKind
  variant: 'normal' | 'easter'
}

type ResolveSoundClipOptions = {
  eventId: SoundEventId
  authorPackId: string | null | undefined
  eventPackId?: string | null
  easterEnabled?: boolean
  random?: () => number
}

function clipPath(packId: string, fileName: string) {
  return `/sounds/ui/${packId}/${fileName}`
}

const ZOVKORD_SOUND_FILES: Record<SoundEventId, string> = {
  'message.default': 'unmute.ogg',
  'message.mention': 'user-join.ogg',
  'message.reaction': 'unmute.ogg',
  'voice.user_join': 'user-join.ogg',
  'voice.user_leave': 'user-leave.ogg',
  'voice.user_move': 'user-join.ogg',
  'voice.mute': 'mute.ogg',
  'voice.unmute': 'unmute.ogg',
  'voice.deafen': 'deafen.ogg',
  'voice.undeafen': 'undeafen.ogg',
  'voice.disconnect': 'user-leave.ogg',
  'call.incoming_ring': 'user-join.ogg',
  'call.outgoing_ring': 'user-join.ogg',
  'call.connected': 'user-join.ogg',
  'call.ended': 'user-leave.ogg',
  'screen_share.started': 'screen-share-started.ogg',
  'screen_share.stopped': 'screen-share-stopped.ogg',
  'camera.started': 'unmute.ogg',
  'camera.stopped': 'mute.ogg',
}

const ZOVKORD_SOUNDS = Object.fromEntries(
  UI_SOUND_EVENTS.map((eventId) => [
    eventId,
    { src: clipPath('zovkord', ZOVKORD_SOUND_FILES[eventId]) },
  ]),
) as Record<SoundEventId, SoundClip>

const AUTHOR_SOUND_PACKS: SoundPack[] = [
  {
    id: 'zovkord',
    label: 'ZovKord',
    kind: 'author',
    sounds: ZOVKORD_SOUNDS,
    easter: ZOVKORD_SOUNDS,
  },
]

const EVENT_SOUND_PACKS: SoundPack[] = []

export function authorSoundPackOptions() {
  return AUTHOR_SOUND_PACKS.map((pack) => ({
    id: pack.id as SoundAuthorPackId,
    label: pack.label,
    kind: pack.kind,
  }))
}

export function eventSoundPackOptions() {
  return EVENT_SOUND_PACKS.map((pack) => ({
    id: pack.id as SoundEventPackId,
    label: pack.label,
    kind: pack.kind,
  }))
}

export function isSoundAuthorPackId(value: unknown): value is SoundAuthorPackId {
  return typeof value === 'string' &&
    (SOUND_AUTHOR_PACK_IDS as readonly string[]).includes(value)
}

export function isSoundEventPackId(value: unknown): value is SoundEventPackId {
  return typeof value === 'string' &&
    (SOUND_EVENT_PACK_IDS as readonly string[]).includes(value)
}

function findAuthorPack(id: string | null | undefined) {
  return (
    AUTHOR_SOUND_PACKS.find((pack) => pack.id === id) ??
    AUTHOR_SOUND_PACKS.find((pack) => pack.id === DEFAULT_SOUND_AUTHOR_PACK_ID)
  )
}

function findEventPack(id: string | null | undefined) {
  return EVENT_SOUND_PACKS.find((pack) => pack.id === id)
}

function resolvedClip(
  pack: SoundPack,
  eventId: SoundEventId,
  variant: 'normal' | 'easter',
  clip: SoundClip,
): ResolvedSoundClip {
  return {
    ...clip,
    eventId,
    packId: pack.id,
    packKind: pack.kind,
    variant,
  }
}

export function resolveSoundClip({
  eventId,
  authorPackId,
  eventPackId,
  easterEnabled = true,
  random = Math.random,
}: ResolveSoundClipOptions): ResolvedSoundClip | null {
  const authorPack = findAuthorPack(authorPackId)
  if (!authorPack) return null

  const eventPack = findEventPack(eventPackId)
  const normalPack = eventPack?.sounds[eventId] ? eventPack : authorPack
  const normal = normalPack.sounds[eventId]
  if (!normal) return null

  const easterPack = eventPack?.easter[eventId] ? eventPack : authorPack
  const easter = easterPack.easter[eventId]
  if (easterEnabled && easter && random() < DEFAULT_EASTER_CHANCE) {
    return resolvedClip(easterPack, eventId, 'easter', easter)
  }

  return resolvedClip(normalPack, eventId, 'normal', normal)
}

export function validateSoundPackCatalog() {
  const errors: string[] = []
  for (const pack of AUTHOR_SOUND_PACKS) {
    for (const eventId of UI_SOUND_EVENTS) {
      if (!pack.sounds[eventId]) errors.push(`${pack.id}:${eventId}:normal`)
      if (!pack.easter[eventId]) errors.push(`${pack.id}:${eventId}:easter`)
    }
  }
  return errors
}
