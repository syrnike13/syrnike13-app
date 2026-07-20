import { CUSTOM_EMOJI_ID_RE } from '#/lib/emoji'
import { MESSAGE_ENTITY_RE } from '#/lib/mentions'

const SYRNIKE_LINK_PREFIX = 'syrnike:'

function isEscapedAt(value: string, index: number) {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) {
    slashes += 1
  }
  return slashes % 2 === 1
}

function replaceUnescaped(
  value: string,
  regex: RegExp,
  replacement: (...args: string[]) => string,
) {
  return value.replace(regex, (...args: unknown[]) => {
    const offset = args.at(-2) as number
    return isEscapedAt(value, offset)
      ? (args[0] as string)
      : replacement(...(args.slice(0, -2) as string[]))
  })
}

function transformOutsideCode(
  content: string,
  transform: (segment: string) => string,
) {
  const code = /(`+)[\s\S]*?\1/g
  let result = ''
  let cursor = 0
  let match = code.exec(content)

  while (match) {
    if (isEscapedAt(content, match.index)) {
      match = code.exec(content)
      continue
    }
    result += transform(content.slice(cursor, match.index)) + match[0]
    cursor = match.index + match[0].length
    match = code.exec(content)
  }

  return result + transform(content.slice(cursor))
}

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
  return transformOutsideCode(content, (segment) => {
    let markdown = segment

    MESSAGE_ENTITY_RE.lastIndex = 0
    markdown = replaceUnescaped(
      markdown,
      MESSAGE_ENTITY_RE,
      (_full, marker, id) => {
      const kind =
        marker === '@' ? 'user' : marker === '%' ? 'role' : 'channel'
      return `[${id}](${SYRNIKE_LINK_PREFIX}${kind}:${id})`
      },
    )

    CUSTOM_EMOJI_ID_RE.lastIndex = 0
    markdown = replaceUnescaped(
      markdown,
      CUSTOM_EMOJI_ID_RE,
      (_full, id) => `[emoji](${SYRNIKE_LINK_PREFIX}emoji:${id})`,
    )

    markdown = replaceUnescaped(
      markdown,
      /@everyone/g,
      () => `[everyone](${SYRNIKE_LINK_PREFIX}mass:everyone)`,
    )
    markdown = replaceUnescaped(
      markdown,
      /@online/g,
      () => `[online](${SYRNIKE_LINK_PREFIX}mass:online)`,
    )

    markdown = replaceUnescaped(
      markdown,
      /\|\|(.+?)\|\|/g,
      (_full, inner) =>
        `[spoiler](${SYRNIKE_LINK_PREFIX}spoiler:${encodeURIComponent(inner)})`,
    )

    return markdown
  })
}
