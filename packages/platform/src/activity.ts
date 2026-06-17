export const ACTIVITY_TYPES = [
  'playing',
  'streaming',
  'listening',
  'watching',
  'custom',
  'competing',
] as const

export type ActivityType = (typeof ACTIVITY_TYPES)[number]

export type ActivityTimestamps = {
  start?: number
  end?: number
}

export type ActivityAssets = {
  largeImageUrl?: string
  largeText?: string
  largeUrl?: string
  smallImageUrl?: string
  smallText?: string
  smallUrl?: string
  inviteCoverImageUrl?: string
}

export type ActivityParty = {
  id?: string
  size?: {
    current: number
    max: number
  }
}

export type ActivityButton = {
  label: string
  url: string
}

export type Activity = {
  activitySourceId: string
  type: ActivityType
  name: string
  url?: string
  createdAt?: number
  observedAt: number
  timestamps?: ActivityTimestamps
  applicationId?: string
  statusDisplayType?: 'name' | 'state' | 'details'
  details?: string
  detailsUrl?: string
  state?: string
  stateUrl?: string
  assets?: ActivityAssets
  party?: ActivityParty
  instance?: boolean
  flags?: number
  buttons?: ActivityButton[]
}

export type ActivityPatch = Activity | null

const MAX_ACTIVITY_IMAGE_DATA_URL_LENGTH = 2_100_000
const SAFE_RASTER_DATA_IMAGE_URL_PATTERN =
  /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/i

function objectRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function activityType(value: unknown): ActivityType | undefined {
  return typeof value === 'string' &&
    (ACTIVITY_TYPES as readonly string[]).includes(value)
    ? (value as ActivityType)
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function nonNegativeInteger(value: unknown) {
  const number = finiteNumber(value)
  return number === undefined ? undefined : Math.max(0, Math.round(number))
}

function safeHttpUrl(value: unknown): string | undefined {
  const raw = nonEmptyString(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

function safeRasterDataImageUrl(value: unknown): string | undefined {
  const raw = nonEmptyString(value)
  if (!raw || raw.length > MAX_ACTIVITY_IMAGE_DATA_URL_LENGTH) return undefined
  return SAFE_RASTER_DATA_IMAGE_URL_PATTERN.test(raw) ? raw : undefined
}

function safeAssetImageUrl(value: unknown): string | undefined {
  return safeHttpUrl(value) ?? safeRasterDataImageUrl(value)
}

function normalizeTimestamps(value: unknown): ActivityTimestamps | undefined {
  const payload = objectRecord(value)
  const start = nonNegativeInteger(payload.start)
  const end = nonNegativeInteger(payload.end)
  if (start === undefined && end === undefined) return undefined
  return {
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
  }
}

function normalizeAssets(value: unknown): ActivityAssets | undefined {
  const payload = objectRecord(value)
  const assets: ActivityAssets = {
    largeImageUrl: safeAssetImageUrl(payload.largeImageUrl),
    largeText: nonEmptyString(payload.largeText),
    largeUrl: safeHttpUrl(payload.largeUrl),
    smallImageUrl: safeAssetImageUrl(payload.smallImageUrl),
    smallText: nonEmptyString(payload.smallText),
    smallUrl: safeHttpUrl(payload.smallUrl),
    inviteCoverImageUrl: safeAssetImageUrl(payload.inviteCoverImageUrl),
  }

  return pruneUndefined(assets)
}

function normalizeParty(value: unknown): ActivityParty | undefined {
  const payload = objectRecord(value)
  const id = nonEmptyString(payload.id)
  const sizePayload = objectRecord(payload.size)
  const current = nonNegativeInteger(sizePayload.current)
  const max = nonNegativeInteger(sizePayload.max)
  const size =
    current !== undefined && max !== undefined
      ? { current, max: Math.max(current, max) }
      : undefined

  return pruneUndefined({
    id,
    size,
  })
}

function normalizeButtons(value: unknown): ActivityButton[] | undefined {
  if (!Array.isArray(value)) return undefined

  const buttons = value.flatMap((entry) => {
    const payload = objectRecord(entry)
    const label = nonEmptyString(payload.label)
    const url = safeHttpUrl(payload.url)
    return label && url ? [{ label, url }] : []
  })

  return buttons.length > 0 ? buttons.slice(0, 2) : undefined
}

function normalizeStatusDisplayType(
  value: unknown,
): Activity['statusDisplayType'] | undefined {
  return value === 'name' || value === 'state' || value === 'details'
    ? value
    : undefined
}

function pruneUndefined<T extends Record<string, unknown>>(value: T) {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined
}

export function normalizeActivity(value: unknown): Activity | null {
  const payload = objectRecord(value)
  const activitySourceId = nonEmptyString(payload.activitySourceId)
  const type = activityType(payload.type)
  const name = nonEmptyString(payload.name)
  const observedAt = nonNegativeInteger(payload.observedAt)

  if (!activitySourceId || !type || !name || observedAt === undefined) {
    return null
  }

  return pruneUndefined({
    activitySourceId,
    type,
    name,
    url: safeHttpUrl(payload.url),
    createdAt: nonNegativeInteger(payload.createdAt),
    observedAt,
    timestamps: normalizeTimestamps(payload.timestamps),
    applicationId: nonEmptyString(payload.applicationId),
    statusDisplayType: normalizeStatusDisplayType(payload.statusDisplayType),
    details: nonEmptyString(payload.details),
    detailsUrl: safeHttpUrl(payload.detailsUrl),
    state: nonEmptyString(payload.state),
    stateUrl: safeHttpUrl(payload.stateUrl),
    assets: normalizeAssets(payload.assets),
    party: normalizeParty(payload.party),
    instance: typeof payload.instance === 'boolean' ? payload.instance : undefined,
    flags: nonNegativeInteger(payload.flags),
    buttons: normalizeButtons(payload.buttons),
  }) as Activity
}

export function normalizeActivityPatch(
  value: unknown,
): ActivityPatch | undefined {
  if (value === null) return null
  const activity = normalizeActivity(value)
  return activity ?? undefined
}
