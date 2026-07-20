const STORAGE_KEY = 'syrnike13:chat-drafts:v1'

type StoredDrafts = Record<string, string>

function draftKey(userId: string, channelId: string) {
  return `${userId}:${channelId}`
}

function readDrafts(): StoredDrafts {
  if (typeof window === 'undefined') return {}

  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (!value) return {}
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string',
      ),
    )
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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
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
