import type { Badge, DataCreateBadge, DataEditBadge, FieldsBadge } from '@syrnike13/api-types'

export type BadgeFormState = {
  slug: string
  name: string
  description: string
  visible: boolean
  premium: boolean
  displayOrder: string
}

export const emptyBadgeForm: BadgeFormState = {
  slug: '',
  name: '',
  description: '',
  visible: true,
  premium: false,
  displayOrder: '0',
}

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
}

export function suggestBadgeSlug(name: string) {
  const transliterated = name
    .trim()
    .toLowerCase()
    .split('')
    .map((char) => TRANSLIT[char] ?? char)
    .join('')

  return transliterated
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 48)
}

export function badgeToForm(badge: Badge): BadgeFormState {
  return {
    slug: badge.slug,
    name: badge.name,
    description: badge.description ?? '',
    visible: badge.visible ?? false,
    premium: badge.premium ?? false,
    displayOrder: String(badge.display_order),
  }
}

export function isBadgeFormDirty(
  form: BadgeFormState,
  baseline: BadgeFormState,
  iconFile: File | null,
  removeIcon: boolean,
) {
  return (
    iconFile !== null ||
    removeIcon ||
    form.slug !== baseline.slug ||
    form.name !== baseline.name ||
    form.description !== baseline.description ||
    form.visible !== baseline.visible ||
    form.premium !== baseline.premium ||
    form.displayOrder !== baseline.displayOrder
  )
}

export function formToCreatePayload(
  form: BadgeFormState,
  iconFileId?: string,
): DataCreateBadge {
  return {
    slug: form.slug.trim(),
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    icon_file_id: iconFileId,
    visible: form.visible,
    premium: form.premium,
    display_order: Number.parseInt(form.displayOrder, 10) || 0,
  }
}

export function formToEditPayload(
  form: BadgeFormState,
  iconFileId?: string,
  removeIcon = false,
): DataEditBadge {
  const description = form.description.trim()
  const remove: FieldsBadge[] = []

  if (!description) {
    remove.push('Description')
  }

  if (removeIcon) {
    remove.push('Icon')
  }

  return {
    slug: form.slug.trim(),
    name: form.name.trim(),
    description: description || undefined,
    icon_file_id: iconFileId,
    visible: form.visible,
    premium: form.premium,
    display_order: Number.parseInt(form.displayOrder, 10) || 0,
    remove,
  }
}
