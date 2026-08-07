import { Option, Schema } from 'effect'

const STORAGE_KEY = 'syrnike13:chat-drafts:v1'

type StoredDrafts = Record<string, string>
const StoredDraftsSchema = Schema.Record(Schema.String, Schema.String)
const StoredDraftsJsonSchema = Schema.fromJsonString(StoredDraftsSchema)

function draftKey(userId: string, channelId: string) {
  return `${userId}:${channelId}`
}

function readDrafts(): StoredDrafts {
  if (typeof window === 'undefined') return {}

  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (!value) return {}
    const decoded = Schema.decodeUnknownOption(StoredDraftsJsonSchema)(value)
    return Option.isSome(decoded) ? { ...decoded.value } : {}
  } catch {
    return {}
  }
}

function writeDrafts(drafts: StoredDrafts) {
  if (typeof window === 'undefined') return

  try {
    if (Object.keys(drafts).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY)
      return
    }
    window.localStorage.setItem(
      STORAGE_KEY,
      Schema.encodeSync(StoredDraftsJsonSchema)(drafts),
    )
  } catch {
    // Draft persistence is best-effort when storage is restricted or full.
  }
}

export function readComposerDraft(userId: string, channelId: string) {
  return readDrafts()[draftKey(userId, channelId)] ?? ''
}

export function writeComposerDraft(
  userId: string,
  channelId: string,
  value: string,
) {
  const drafts = readDrafts()
  const key = draftKey(userId, channelId)

  if (value) drafts[key] = value
  else delete drafts[key]

  writeDrafts(drafts)
}

export const composerDraftStorageKey = STORAGE_KEY
