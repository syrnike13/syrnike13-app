import { CUSTOM_EMOJI_ID_RE } from '#/lib/emoji'
import { MESSAGE_ENTITY_RE } from '#/lib/mentions'

const SYRNIKE_LINK_PREFIX = 'syrnike:'
const MASS_MENTION_TOKEN_RE =
  /(?<![\p{L}\p{N}_])@(everyone|online)(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_])/gu

export function isSyrnikeEntityHref(href: string | undefined) {
  return Boolean(href?.startsWith(SYRNIKE_LINK_PREFIX))
}

export function parseSyrnikeEntityHref(href: string) {
  const body = href.slice(SYRNIKE_LINK_PREFIX.length)
  const separator = body.indexOf(':')
  if (separator === -1) return null

  return {
    kind: body.slice(0, separator),
    id: body.slice(separator + 1),
  }
}

/** Заменяет entity-токены Сырников на markdown-ссылки для react-markdown. */
export function prepareMessageMarkdown(content: string): string {
  let markdown = content

  MESSAGE_ENTITY_RE.lastIndex = 0
  markdown = markdown.replace(
    MESSAGE_ENTITY_RE,
    (_full, marker: string, id: string) => {
      const kind =
        marker === '@' ? 'user' : marker === '%' ? 'role' : 'channel'
      return `[${id}](${SYRNIKE_LINK_PREFIX}${kind}:${id})`
    },
  )

  CUSTOM_EMOJI_ID_RE.lastIndex = 0
  markdown = markdown.replace(
    CUSTOM_EMOJI_ID_RE,
    (_full, id: string) => `[emoji](${SYRNIKE_LINK_PREFIX}emoji:${id})`,
  )

  markdown = markdown.replace(
    MASS_MENTION_TOKEN_RE,
    (_full, kind: string) => `[${kind}](${SYRNIKE_LINK_PREFIX}mass:${kind})`,
  )

  markdown = markdown.replace(
    /\|\|(.+?)\|\|/g,
    (_full, inner: string) =>
      `[spoiler](${SYRNIKE_LINK_PREFIX}spoiler:${encodeURIComponent(inner)})`,
  )

  return markdown
}
