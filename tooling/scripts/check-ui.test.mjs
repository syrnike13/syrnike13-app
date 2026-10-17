import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkSource, compare, normalizePath } from './check-ui.mjs'

const rules = (path, source) => checkSource(path, source).map((violation) => violation.rule)

test('normalizes Windows paths for baseline lookups', () => {
  assert.equal(normalizePath('apps\\web\\src\\button.tsx'), 'apps/web/src/button.tsx')
  assert.equal(normalizePath('apps/web/src/button.tsx'), 'apps/web/src/button.tsx')
})

test('flags palette and arbitrary colors, keeps semantic tokens', () => {
  assert.deepEqual(rules('a.tsx', '<p className="text-emerald-600 dark:hover:bg-zinc-900/50" />'), ['palette-color'])
  assert.deepEqual(rules('a.tsx', '<p className="bg-[#fff]" />'), ['arbitrary-color'])
  assert.deepEqual(rules('a.tsx', '<p className="text-muted-foreground bg-card text-success border-border/60" />'), [])
})

test('flags radius and px sizes outside tokens', () => {
  assert.deepEqual(rules('a.tsx', '<div className="rounded-[12px]" />'), ['arbitrary-radius'])
  assert.deepEqual(rules('a.tsx', '<div className="rounded-[inherit] rounded-[var(--radius)]" />'), [])
  assert.deepEqual(rules('a.tsx', '<div className="h-[180px] md:text-[11px]" />'), ['px-size'])
  assert.deepEqual(rules('a.tsx', '<div className="h-11 border-[1px] max-w-[18rem]" />'), [])
})

test('flags size switches on mobile, not compact layout variants', () => {
  assert.deepEqual(rules('a.tsx', "cn('px-4', isMobile ? 'h-11' : 'h-8')"), ['mobile-size-branch'])
  assert.deepEqual(rules('a.tsx', "compact ? 'size-32' : 'size-40'"), [])
})

test('flags restyled surfaces of shared components, allows layout and text tokens', () => {
  const restyled = `<Button
    variant="ghost"
    onClick={() => run()}
    className={cn('w-full rounded-xl', active && 'bg-card')}
  />`
  const violations = checkSource('a.tsx', restyled)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].rule, 'restyle-shared')
  assert.equal(violations[0].line, 1)
  assert.match(violations[0].text, /rounded-xl bg-card/)

  assert.deepEqual(rules('a.tsx', '<Button variant="ghost" className="w-full justify-start text-muted-foreground md:mr-auto" />'), [])
  assert.deepEqual(rules('a.tsx', '<Input className="border-b" />'), [])
})

test('flags Cyrillic UI strings, not comments or English text', () => {
  assert.deepEqual(rules('a.tsx', '<p>Привет</p>'), ['hardcoded-string'])
  assert.deepEqual(rules('a.tsx', "const label = 'Привет'"), ['hardcoded-string'])
  assert.deepEqual(rules('a.tsx', '<p>Hello</p>'), [])
  assert.deepEqual(rules('a.tsx', '// Привет, это комментарий'), [])
  assert.deepEqual(rules('a.tsx', "const t = useTranslations('chat')"), [])
})

test('design-allow skips hardcoded-string for technical strings', () => {
  assert.deepEqual(
    rules('a.tsx', "// design-allow hardcoded-string: log line\nconsole.error('Ошибка')"),
    [],
  )
})

test('flags direct icon imports outside the icon registry', () => {
  assert.deepEqual(rules('apps/web/src/components/chat/a.tsx', "import { X } from '@remixicon/react'"), ['icon-import'])
  assert.deepEqual(rules('apps/web/src/components/icons/index.tsx', "import { X } from '@remixicon/react'"), [])
  assert.deepEqual(rules('apps/admin/src/components/icons.ts', "import { X } from '@remixicon/react'"), [])
  assert.deepEqual(rules('packages/ui/src/icons/index.ts', "import { X } from 'lucide-react'"), [])
  assert.deepEqual(rules('apps/web/src/components/chat/a.tsx', "import { X } from '#/components/icons'"), [])
})

test('checks CSS colors and radius, allowing circles and tokens', () => {
  assert.deepEqual(rules('a.css', '.a { color: #fff; }'), ['css-color'])
  assert.deepEqual(rules('a.css', '.a { border-radius: 12px; }'), ['css-radius'])
  assert.deepEqual(rules('a.css', '.a { border-radius: var(--radius); border-radius: inherit; color: var(--foreground); }'), [])
  assert.deepEqual(rules('a.css', '.dot { border-radius: 50%; }'), [])
})

test('design-allow on the same or previous line skips that rule only', () => {
  assert.deepEqual(rules('a.tsx', "// design-allow palette-color: brand mark\n<p className='text-white' />"), [])
  assert.deepEqual(rules('a.tsx', "<p className='text-white h-[3px]' /> {/* design-allow palette-color: scrim */}"), ['px-size'])
})

test('design-allow-file exempts a whole file for that rule', () => {
  assert.deepEqual(rules('a.tsx', "// design-allow-file palette-color: document paper\n\n<p className='bg-white h-[3px]' />"), ['px-size'])
  assert.deepEqual(rules('a.tsx', '<p className="shadow-black/5 bg-scrim" />'), [])
})

test('baseline tolerates existing counts and reports regressions and improvements', () => {
  const results = new Map([['a.tsx', [{ rule: 'palette-color' }, { rule: 'palette-color' }]]])
  assert.deepEqual(compare(results, { 'a.tsx': { 'palette-color': 2 } }), { regressions: [], improvements: [] })
  assert.deepEqual(compare(results, { 'a.tsx': { 'palette-color': 1 } }).regressions, [
    { file: 'a.tsx', rule: 'palette-color', count: 2, allowed: 1 },
  ])
  assert.deepEqual(compare(new Map(), { 'a.tsx': { 'palette-color': 1 } }).improvements, [{ file: 'a.tsx', rule: 'palette-color' }])
})
