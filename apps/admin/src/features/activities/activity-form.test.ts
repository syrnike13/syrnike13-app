import { describe, expect, it } from 'vitest'

import {
  activityToForm,
  emptyActivityForm,
  formToCreatePayload,
  formToEditPayload,
  hasActivityFormErrors,
  isActivityFormDirty,
  newActivityMapping,
  validateActivityForm,
  type ActivityFormState,
} from '#/features/activities/activity-form'
import type { AdminActivityApplication } from '#/features/api/activities-api'

const validForm: ActivityFormState = {
  ...emptyActivityForm,
  id: 'chess',
  name: ' Chess ',
  description: '',
  originUrl: 'https://chess.example.com',
  maxParticipants: '2',
  enabled: true,
}

const application: AdminActivityApplication = {
  _id: 'chess',
  name: 'Chess',
  description: 'Board game',
  activity_url: 'https://chess.activities.syrnike13.ru',
  max_participants: 2,
  first_party: true,
  origin_url: 'https://chess.example.com',
  url_mappings: [{ prefix: 'api', target: 'https://api.example.com' }],
  enabled: true,
  has_client_secret: false,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
}

describe('activity form validation', () => {
  it('accepts a valid form', () => {
    expect(hasActivityFormErrors(validateActivityForm(validForm))).toBe(false)
  })

  it.each([
    ['', 'required'],
    ['Chess', 'idFormat'],
    ['-chess', 'idFormat'],
    ['chess-', 'idFormat'],
    ['a'.repeat(33), 'idFormat'],
  ])('rejects id %j', (id, error) => {
    expect(validateActivityForm({ ...validForm, id }).id).toBe(error)
  })

  it('accepts a 32-character id with inner hyphens', () => {
    const id = `a-${'b'.repeat(29)}c`
    expect(validateActivityForm({ ...validForm, id }).id).toBeUndefined()
  })

  it('checks name, description, origin and participant limits', () => {
    const errors = validateActivityForm({
      ...validForm,
      name: 'x'.repeat(65),
      description: 'x'.repeat(257),
      originUrl: 'ftp://example.com',
      maxParticipants: '100',
    })
    expect(errors).toMatchObject({
      name: 'nameLength',
      description: 'descriptionLength',
      originUrl: 'url',
      maxParticipants: 'participantsRange',
    })
    expect(
      validateActivityForm({ ...validForm, maxParticipants: '0' }).maxParticipants,
    ).toBe('participantsRange')
    expect(
      validateActivityForm({ ...validForm, maxParticipants: '1.5' })
        .maxParticipants,
    ).toBe('participantsRange')
  })

  it('validates url mappings per row and rejects duplicate prefixes', () => {
    const first = newActivityMapping('api', 'https://api.example.com')
    const duplicate = newActivityMapping('api', 'https://other.example.com')
    const invalid = newActivityMapping('_bad', 'not a url')
    const errors = validateActivityForm({
      ...validForm,
      urlMappings: [first, duplicate, invalid],
    })

    expect(errors.mappings[first.key]).toBeUndefined()
    expect(errors.mappings[duplicate.key]).toEqual({ prefix: 'prefixDuplicate' })
    expect(errors.mappings[invalid.key]).toEqual({
      prefix: 'prefixFormat',
      target: 'url',
    })
  })
})

describe('activity form payloads', () => {
  it('builds a trimmed create payload', () => {
    expect(
      formToCreatePayload(
        {
          ...validForm,
          urlMappings: [newActivityMapping(' api ', ' https://api.example.com ')],
        },
        'file-1',
      ),
    ).toEqual({
      id: 'chess',
      name: 'Chess',
      description: undefined,
      icon_file_id: 'file-1',
      origin_url: 'https://chess.example.com',
      url_mappings: [{ prefix: 'api', target: 'https://api.example.com' }],
      max_participants: 2,
      first_party: false,
      enabled: true,
    })
  })

  it('clears description and icon through remove on edit', () => {
    const payload = formToEditPayload(
      { ...activityToForm(application), description: '  ' },
      undefined,
      true,
    )
    expect(payload).toMatchObject({
      name: 'Chess',
      url_mappings: [{ prefix: 'api', target: 'https://api.example.com' }],
      first_party: true,
      remove: ['Description', 'Icon'],
    })
    expect(payload).not.toHaveProperty('id')
  })

  it('tracks dirty state without depending on row keys', () => {
    const baseline = activityToForm(application)
    const copy = activityToForm(application)
    expect(isActivityFormDirty(copy, baseline, null, false)).toBe(false)
    expect(
      isActivityFormDirty(
        { ...copy, urlMappings: [] },
        baseline,
        null,
        false,
      ),
    ).toBe(true)
    expect(isActivityFormDirty(copy, baseline, null, true)).toBe(true)
  })
})
