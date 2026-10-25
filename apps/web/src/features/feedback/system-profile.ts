import type { FeedbackPeripheral, FeedbackSystem } from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Option, Schema } from 'effect'

const STORAGE_KEY = 'syrnike.feedback.system-profile.v1'

const StoredProfileSchema = Schema.Struct({
  system: Schema.Union([ApiSchema.FeedbackSystem, Schema.Null]),
  peripherals: Schema.Array(ApiSchema.FeedbackPeripheral),
})

export type FeedbackSystemProfile = {
  system: FeedbackSystem | null
  peripherals: FeedbackPeripheral[]
}

type ProfileStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Remember the hardware summary and devices on this machine so the next bug
 * report can prefill them. Storage is best-effort: a locked-down browser must
 * not break the dialog.
 */
export function readSystemProfile(
  storage: ProfileStorage | null = browserStorage(),
): FeedbackSystemProfile | null {
  if (!storage) return null

  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null

    const decoded = Schema.decodeUnknownOption(StoredProfileSchema)(JSON.parse(raw))
    return Option.isSome(decoded)
      ? { system: decoded.value.system, peripherals: [...decoded.value.peripherals] }
      : null
  } catch {
    return null
  }
}

export function writeSystemProfile(
  profile: FeedbackSystemProfile,
  storage: ProfileStorage | null = browserStorage(),
): boolean {
  if (!storage) return false
  if (!profile.system && profile.peripherals.length === 0) return false

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(profile))
    return true
  } catch {
    return false
  }
}

export function clearSystemProfile(
  storage: ProfileStorage | null = browserStorage(),
): void {
  try {
    storage?.removeItem(STORAGE_KEY)
  } catch {
    // Ignore: losing the stored profile is never worth an error in the dialog.
  }
}

function browserStorage(): ProfileStorage | null {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage
  } catch {
    return null
  }
}
