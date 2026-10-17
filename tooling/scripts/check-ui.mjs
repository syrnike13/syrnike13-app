#!/usr/bin/env node
// UI rules from packages/ui/AGENTS.md as a failing check. Existing violations live in
// tooling/ui-baseline.json; a file may only keep or lower its count per rule.
//   pnpm check:ui            — fail on new violations
//   pnpm check:ui:update     — rewrite the baseline after fixing old ones
//   node tooling/scripts/check-ui.mjs --all — list every violation, including baseline
// Escape hatch for a deliberate exception, on the same or the previous line:
//   // design-allow <rule>: <why>        {/* design-allow <rule>: <why> */}
// or for a whole file, within its first 12 lines: // design-allow-file <rule>: <why>

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const BASELINE = join(ROOT, 'tooling', 'ui-baseline.json')

export const SCOPES = [
  'packages/ui/src',
  'apps/web/src/components',
  'apps/web/src/features',
  'apps/web/src/routes',
  'apps/admin/src',
]

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.output', 'test-results', 'coverage'])
const SKIP_FILE = /\.(test|spec|stories)\.[jt]sx?$|\.gen\.ts$|\.d\.ts$/
const SKIP_PATH = /(?:^|\/)(?:messages|test-fixtures)\//

const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black'
const COLOR_UTILITY =
  'bg|text|border(?:-[trblxy])?|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|placeholder|caret|accent|shadow'
const SIZE_UTILITY =
  'w|h|size|min-w|max-w|min-h|max-h|p[xytrbl]?|m[xytrbl]?|gap(?:-[xy])?|space-[xy]|top|right|bottom|left|inset(?:-[xy])?|text|leading|tracking|basis|translate-[xy]'

const TOKENS_HINT =
  'Цвета только из семантических токенов: text-foreground, text-muted-foreground, bg-card, bg-muted, ' +
  'bg-accent, border-border, bg-primary/text-primary, text-destructive, text-success, text-warning. ' +
  'Нужного токена нет — добавь его в packages/ui/src/styles.css, не придумывай цвет.'

const ICON_IMPORT_PATTERN = /from\s+['"](@remixicon\/react|@iconify\/react|iconoir-react(?:\/solid)?|lucide-react)['"]/
const CYRILLIC = /[Ѐ-ӿ]/
const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
const JSX_TEXT = />([^<>{}]+)</g

/** @typedef {{ rule: string, line: number, text: string, message: string }} Violation */

/** Rules that look at one line at a time. `files` limits a rule to source or CSS files. */
const LINE_RULES = [
  {
    rule: 'palette-color',
    files: 'source',
    pattern: new RegExp(`(?<![\\w-])(?:[\\w-]+:)*(?!shadow-black)(?:${COLOR_UTILITY})-(?:${PALETTE})(?:-\\d{2,3})?(?:\\/\\d+)?(?![\\w-])`),
    message: `Цвет из палитры Tailwind вместо семантического токена. ${TOKENS_HINT}`,
  },
  {
    rule: 'arbitrary-color',
    files: 'source',
    pattern: new RegExp(`(?:${COLOR_UTILITY})-\\[(?:#|rgb|hsl|oklch|oklab|color-mix)`),
    message: `Произвольный цвет в классе. ${TOKENS_HINT}`,
  },
  {
    rule: 'arbitrary-radius',
    files: 'source',
    pattern: /rounded(?:-[trblse]{1,2})?-\[(?!inherit\])(?!var\(--(?:radius|squircle))[^\]]+\]/,
    message:
      'Произвольный радиус. Возьми токен rounded-xs…4xl, Squircle radius="…" или var(--radius) через токен.',
  },
  {
    rule: 'px-size',
    files: 'source',
    pattern: new RegExp(`(?<![\\w-])(?:[\\w-]+:)*-?(?:${SIZE_UTILITY})-\\[-?\\d*\\.?\\d+px\\]`),
    message: 'Размеры в rem, по возможности классами Tailwind (h-9, gap-2, max-w-sm). px — только для границ, focus-offset, canvas.',
  },
  {
    rule: 'mobile-size-branch',
    files: 'source',
    pattern: /\b(?:isMobile|mobile|isPhone)\s*\?\s*['"`][^'"`]*(?<![\w-])(?:h|min-h|size|text|px|py)-(?:\d|xs|sm|base|lg|xl)/,
    message:
      'Не переключай размеры по mobile: Input, Textarea, SelectTrigger, Button и пункты меню адаптируются сами через CSS. Фиксированный size — только для намеренного исключения.',
  },
  {
    rule: 'icon-import',
    files: 'source',
    pattern: ICON_IMPORT_PATTERN,
    message:
      'Иконки только через реестр packages/ui/src/icons или app-local icons. Прямые импорты @remixicon/react, @iconify/react, iconoir-react и lucide-react запрещены.',
  },
  {
    rule: 'css-color',
    files: 'css',
    pattern: /(?:^|[{;])\s*(?!--)[a-z-]*(?:color|background|border|fill|stroke|shadow)[a-z-]*\s*:[^;]*(?:#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\()/,
    message: `Цвет в CSS вместо var(--…) токена. ${TOKENS_HINT}`,
  },
  {
    rule: 'css-radius',
    files: 'css',
    pattern: /(?:^|[{;])\s*border(?:-[a-z]+)*-radius\s*:\s*(?!\s)(?!0\s*[;!]|inherit|50%|9999px|999px|var\(--(?:radius|squircle))[^;]+/,
    message: 'border-radius только через токен var(--radius) или Squircle; настоящий круг — 50%.',
  },
]

/** Shared components own their surface (background, border, shape) and state; callers add only layout.
 * Text color tokens stay allowed: `<Button variant="ghost" className="text-muted-foreground">` is the house pattern. */
const OWNED_STATE_COMPONENTS = [
  'Button',
  'Badge',
  'Input',
  'Textarea',
  'SelectTrigger',
  'Alert',
  'TabsTrigger',
  'Switch',
  'Checkbox',
  'ListItem',
  'SearchField',
  'Field',
]
const OWNED_STATE_CLASS =
  /(?<![\w-])(?:[\w-]+:)*(?:bg-|border-(?!0\b|\d|[trblxy]-?\d|[trblxy]\b|solid|dashed|none\b)|rounded-(?!none\b|full\b)|shadow-|ring-|outline-)[\w/.\[\]-]*/

export function isCss(path) {
  return path.endsWith('.css')
}

function isIconRegistry(path) {
  return (
    path.startsWith('packages/ui/src/icons/') ||
    path.startsWith('apps/web/src/components/icons/') ||
    path.startsWith('apps/admin/src/components/icons')
  )
}

/** Normalize a path for baseline/CI comparisons across platforms. */
export function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

function allowed(lines, index, rule) {
  const marker = new RegExp(`design-allow\\s+(?:[\\w-]+,\\s*)*${rule}\\b`)
  return marker.test(lines[index]) || (index > 0 && marker.test(lines[index - 1]))
}

/** `design-allow-file <rule>: <why>` in the first lines exempts a whole file (document paper, terminal, brand art). */
function allowedFile(lines, rule) {
  const marker = new RegExp(`design-allow-file\\s+(?:[\\w-]+,\\s*)*${rule}\\b`)
  return lines.slice(0, 12).some((line) => marker.test(line))
}

/** Opening JSX tags of `name` with their full text, tracking `{…}` so `=>` does not end the tag. */
function* jsxTags(source, name) {
  const opening = new RegExp(`<${name}(?=[\\s/>])`, 'g')
  for (const match of source.matchAll(opening)) {
    let depth = 0
    let end = match.index + match[0].length
    for (; end < source.length; end += 1) {
      const char = source[end]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      else if (char === '>' && depth === 0) break
    }
    yield { start: match.index, text: source.slice(match.index, end + 1) }
  }
}

function lineOf(source, offset) {
  let line = 1
  for (let i = 0; i < offset; i += 1) if (source.charCodeAt(i) === 10) line += 1
  return line
}

function classValues(tag) {
  const values = []
  for (const match of tag.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{([\s\S]*?)\}(?=\s+[\w-]+=|\s*\/?>))/g)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? ''
    if (match[3] === undefined) values.push(raw)
    else for (const literal of raw.matchAll(/(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)) values.push(literal[2])
  }
  return values
}

/** @returns {Violation[]} */
export function checkSource(path, source) {
  const normalizedPath = normalizePath(path)
  const lines = source.split(/\r?\n/)
  const css = isCss(normalizedPath)
  /** @type {Violation[]} */
  const found = []

  for (const [index, text] of lines.entries()) {
    const trimmed = text.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    for (const { rule, files, pattern, message } of LINE_RULES) {
      if ((files === 'css') !== css) continue
      if (rule === 'icon-import' && isIconRegistry(normalizedPath)) continue
      if (!pattern.test(text) || allowed(lines, index, rule) || allowedFile(lines, rule)) continue
      found.push({ rule, line: index + 1, text: trimmed, message })
    }
  }

  if (!css) {
    for (const [index, text] of lines.entries()) {
      const trimmed = text.trim()
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      ) {
        continue
      }

      let hasCyrillic = false
      for (const match of text.matchAll(STRING_LITERAL)) {
        if (CYRILLIC.test(match[2])) {
          hasCyrillic = true
          break
        }
      }
      if (!hasCyrillic) {
        for (const match of text.matchAll(JSX_TEXT)) {
          if (CYRILLIC.test(match[1])) {
            hasCyrillic = true
            break
          }
        }
      }
      if (!hasCyrillic) continue
      if (
        allowed(lines, index, 'hardcoded-string') ||
        allowedFile(lines, 'hardcoded-string')
      ) {
        continue
      }

      found.push({
        rule: 'hardcoded-string',
        line: index + 1,
        text: trimmed,
        message:
          'Строки интерфейса только через useTranslations; ключи в apps/{web,admin}/src/messages/{en,ru}.json. Технические строки — design-allow hardcoded-string: причина.',
      })
    }
  }

  if (!css && normalizedPath.endsWith('.tsx')) {
    for (const name of OWNED_STATE_COMPONENTS) {
      for (const tag of jsxTags(source, name)) {
        const offending = classValues(tag.text)
          .flatMap((value) => value.split(/\s+/))
          .filter((token) => OWNED_STATE_CLASS.test(token))
        if (offending.length === 0) continue
        const line = lineOf(source, tag.start)
        if (allowed(lines, line - 1, 'restyle-shared')) continue
        found.push({
          rule: 'restyle-shared',
          line,
          text: `<${name} className="… ${[...new Set(offending)].join(' ')} …">`,
          message: `${name} сам владеет фоном, рамкой, формой и состояниями. Нужен другой вид — добавь variant в packages/ui; в className только layout (w-full, mt-2, justify-start, md:mr-auto).`,
        })
      }
    }
  }

  return found
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(tsx?|css)$/.test(entry) && !SKIP_FILE.test(entry)) yield full
  }
}

export function scan(root = ROOT) {
  /** @type {Map<string, Violation[]>} */
  const results = new Map()
  for (const scope of SCOPES) {
    const dir = join(root, scope)
    if (!existsSync(dir)) continue
    for (const file of walk(dir)) {
      const relativePath = normalizePath(relative(root, file))
      if (SKIP_PATH.test(`/${relativePath}`)) continue
      const violations = checkSource(relativePath, readFileSync(file, 'utf8'))
      if (violations.length > 0) results.set(relativePath, violations)
    }
  }
  return results
}

/** Per file and rule: how many violations the baseline still tolerates. */
export function countByRule(results) {
  const counts = {}
  for (const [file, violations] of [...results].sort(([a], [b]) => a.localeCompare(b))) {
    counts[file] = {}
    for (const { rule } of violations) counts[file][rule] = (counts[file][rule] ?? 0) + 1
  }
  return counts
}

export function compare(results, baseline) {
  const regressions = []
  const improvements = []
  const current = countByRule(results)
  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowedCount = baseline[file]?.[rule] ?? 0
      if (count > allowedCount) regressions.push({ file, rule, count, allowed: allowedCount })
    }
  }
  for (const [file, rules] of Object.entries(baseline)) {
    for (const [rule, allowedCount] of Object.entries(rules)) {
      if ((current[file]?.[rule] ?? 0) < allowedCount) improvements.push({ file, rule })
    }
  }
  return { regressions, improvements }
}

function main(args) {
  const results = scan()
  if (args.includes('--update')) {
    writeFileSync(BASELINE, `${JSON.stringify(countByRule(results), null, 2)}\n`)
    console.log(`check:ui: baseline обновлён (${relative(ROOT, BASELINE)}).`)
    return 0
  }

  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
  const { regressions, improvements } = compare(results, baseline)
  const listed = args.includes('--all')
    ? [...results].flatMap(([file, violations]) => violations.map((violation) => ({ file, ...violation })))
    : regressions.flatMap(({ file, rule }) => results.get(file).filter((v) => v.rule === rule).map((v) => ({ file, ...v })))

  for (const { file, line, rule, text, message } of listed) {
    console.log(`${file}:${line}  [${rule}]  ${text.slice(0, 140)}\n  → ${message}\n`)
  }

  if (regressions.length > 0) {
    console.log('check:ui: новые нарушения UI-правил (см. выше). Исправь код, а не baseline.')
    console.log('Правила и каталог компонентов: packages/ui/AGENTS.md. Осознанное исключение — комментарий `design-allow <rule>: <причина>`.')
    for (const { file, rule, count, allowed: allowedCount } of regressions) {
      console.log(`  ${file}  ${rule}: ${count} (допускается ${allowedCount})`)
    }
    return 1
  }
  if (improvements.length > 0) {
    console.log(`check:ui: OK. Старых нарушений стало меньше в ${improvements.length} местах — зафиксируй: pnpm check:ui:update`)
  } else {
    console.log('check:ui: OK')
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
