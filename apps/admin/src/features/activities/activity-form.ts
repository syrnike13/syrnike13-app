import type {
  AdminActivityApplication,
  DataCreateActivityApplication,
  DataEditActivityApplication,
  FieldsActivityApplication,
} from '#/features/api/activities-api'

// Mirrors the backend validation in
// `services/backend/crates/core/models/src/v0/activities.rs`.
export const ACTIVITY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
export const ACTIVITY_URL_MAPPING_PREFIX_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const ACTIVITY_NAME_MAX_LENGTH = 64
export const ACTIVITY_DESCRIPTION_MAX_LENGTH = 256
export const ACTIVITY_MAX_PARTICIPANTS_MIN = 1
export const ACTIVITY_MAX_PARTICIPANTS_MAX = 99

export type ActivityMappingFormState = {
  /** Stable React key; never sent to the API. */
  key: string
  prefix: string
  target: string
}

export type ActivityFormState = {
  id: string
  name: string
  description: string
  originUrl: string
  urlMappings: ActivityMappingFormState[]
  maxParticipants: string
  firstParty: boolean
  enabled: boolean
}

/** Message keys under `activities.editor.errors`. */
export type ActivityFormErrorKey =
  | 'required'
  | 'idFormat'
  | 'nameLength'
  | 'descriptionLength'
  | 'url'
  | 'participantsRange'
  | 'prefixFormat'
  | 'prefixDuplicate'

export type ActivityFormErrors = {
  id?: ActivityFormErrorKey
  name?: ActivityFormErrorKey
  description?: ActivityFormErrorKey
  originUrl?: ActivityFormErrorKey
  maxParticipants?: ActivityFormErrorKey
  mappings: Record<
    string,
    { prefix?: ActivityFormErrorKey; target?: ActivityFormErrorKey }
  >
}

export const emptyActivityForm: ActivityFormState = {
  id: '',
  name: '',
  description: '',
  originUrl: '',
  urlMappings: [],
  maxParticipants: '8',
  firstParty: false,
  enabled: false,
}

let mappingKeySeq = 0

export function newActivityMapping(
  prefix = '',
  target = '',
): ActivityMappingFormState {
  mappingKeySeq += 1
  return { key: `mapping-${mappingKeySeq}`, prefix, target }
}

export function activityToForm(
  application: AdminActivityApplication,
): ActivityFormState {
  return {
    id: application._id,
    name: application.name,
    description: application.description ?? '',
    originUrl: application.origin_url,
    urlMappings: application.url_mappings.map((mapping) =>
      newActivityMapping(mapping.prefix, mapping.target),
    ),
    maxParticipants: String(application.max_participants),
    firstParty: application.first_party ?? false,
    enabled: application.enabled,
  }
}

function mappingsSignature(mappings: ActivityMappingFormState[]) {
  return JSON.stringify(mappings.map(({ prefix, target }) => [prefix, target]))
}

export function isActivityFormDirty(
  form: ActivityFormState,
  baseline: ActivityFormState,
  iconFile: File | null,
  removeIcon: boolean,
) {
  return (
    iconFile !== null ||
    removeIcon ||
    form.id !== baseline.id ||
    form.name !== baseline.name ||
    form.description !== baseline.description ||
    form.originUrl !== baseline.originUrl ||
    form.maxParticipants !== baseline.maxParticipants ||
    form.firstParty !== baseline.firstParty ||
    form.enabled !== baseline.enabled ||
    mappingsSignature(form.urlMappings) !== mappingsSignature(baseline.urlMappings)
  )
}

export function isHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function parseParticipants(value: string) {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  return parsed >= ACTIVITY_MAX_PARTICIPANTS_MIN &&
    parsed <= ACTIVITY_MAX_PARTICIPANTS_MAX
    ? parsed
    : null
}

export function validateActivityForm(
  form: ActivityFormState,
): ActivityFormErrors {
  const errors: ActivityFormErrors = { mappings: {} }
  const id = form.id.trim()
  const name = form.name.trim()
  const originUrl = form.originUrl.trim()

  if (!id) errors.id = 'required'
  else if (!ACTIVITY_ID_PATTERN.test(id)) errors.id = 'idFormat'

  if (!name) errors.name = 'required'
  else if (name.length > ACTIVITY_NAME_MAX_LENGTH) errors.name = 'nameLength'

  if (form.description.trim().length > ACTIVITY_DESCRIPTION_MAX_LENGTH) {
    errors.description = 'descriptionLength'
  }

  if (!originUrl) errors.originUrl = 'required'
  else if (!isHttpUrl(originUrl)) errors.originUrl = 'url'

  if (parseParticipants(form.maxParticipants) === null) {
    errors.maxParticipants = 'participantsRange'
  }

  const seenPrefixes = new Set<string>()
  for (const mapping of form.urlMappings) {
    const prefix = mapping.prefix.trim()
    const target = mapping.target.trim()
    const rowErrors: ActivityFormErrors['mappings'][string] = {}

    if (!prefix) rowErrors.prefix = 'required'
    else if (!ACTIVITY_URL_MAPPING_PREFIX_PATTERN.test(prefix)) {
      rowErrors.prefix = 'prefixFormat'
    } else if (seenPrefixes.has(prefix)) rowErrors.prefix = 'prefixDuplicate'
    seenPrefixes.add(prefix)

    if (!target) rowErrors.target = 'required'
    else if (!isHttpUrl(target)) rowErrors.target = 'url'

    if (rowErrors.prefix || rowErrors.target) {
      errors.mappings[mapping.key] = rowErrors
    }
  }

  return errors
}

export function hasActivityFormErrors(errors: ActivityFormErrors) {
  return Boolean(
    errors.id ||
      errors.name ||
      errors.description ||
      errors.originUrl ||
      errors.maxParticipants ||
      Object.keys(errors.mappings).length > 0,
  )
}

function mappingsPayload(form: ActivityFormState) {
  return form.urlMappings.map((mapping) => ({
    prefix: mapping.prefix.trim(),
    target: mapping.target.trim(),
  }))
}

export function formToCreatePayload(
  form: ActivityFormState,
  iconFileId?: string,
): DataCreateActivityApplication {
  return {
    id: form.id.trim(),
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    icon_file_id: iconFileId,
    origin_url: form.originUrl.trim(),
    url_mappings: mappingsPayload(form),
    max_participants: parseParticipants(form.maxParticipants) ?? 0,
    first_party: form.firstParty,
    enabled: form.enabled,
  }
}

export function formToEditPayload(
  form: ActivityFormState,
  iconFileId?: string,
  removeIcon = false,
): DataEditActivityApplication {
  const description = form.description.trim()
  const remove: FieldsActivityApplication[] = []

  if (!description) remove.push('Description')
  if (removeIcon) remove.push('Icon')

  return {
    name: form.name.trim(),
    description: description || undefined,
    icon_file_id: iconFileId,
    origin_url: form.originUrl.trim(),
    url_mappings: mappingsPayload(form),
    max_participants: parseParticipants(form.maxParticipants) ?? 0,
    first_party: form.firstParty,
    enabled: form.enabled,
    remove,
  }
}
