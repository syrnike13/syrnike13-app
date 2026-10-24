import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import css from '@eslint/css'
import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'

import { designCssPlugin, designPlugin } from './index.mjs'
import { loadSurfacedPrimitives } from './primitives.mjs'

RuleTester.describe = describe
RuleTester.it = it

const primitivesDir = mkdtempSync(join(tmpdir(), 'design-primitives-'))
function primitive(folder, source) {
  mkdirSync(join(primitivesDir, folder))
  writeFileSync(join(primitivesDir, folder, 'index.tsx'), source)
}
primitive(
  'button',
  `const buttonVariants = cva("rounded-lg bg-primary")
function Button({ className }) {
  return <button className={cn(buttonVariants({}), className)} />
}`,
)
primitive(
  'popover',
  `function PopoverTrigger(props) {
  return <PopoverPrimitive.Trigger {...props} />
}
function PopoverContent({ className }) {
  return <div className={cn("flex w-72 rounded-lg bg-popover p-2.5", className)} />
}`,
)
primitive(
  'squircle',
  `export function Squircle({ className }) {
  return <div className={cn('size-full min-h-0 min-w-0', className)} />
}`,
)

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})
const options = [{ primitivesDir }]
const imports = `import { Button } from '@syrnike13/ui/primitives/button'
import { PopoverContent, PopoverTrigger } from '@syrnike13/ui/primitives/popover'
import { Squircle } from '@syrnike13/ui/primitives/squircle'
`

tester.run('design/no-restyle', designPlugin.rules['no-restyle'], {
  valid: [
    { code: `${imports}<Button className="mt-2 w-full shrink-0 text-muted-foreground" />`, options },
    { code: `${imports}<Button className={cn('md:ml-auto', open && 'hidden', 'group-hover:opacity-100')} />`, options },
    { code: `${imports}<PopoverContent className="w-80 p-0" />`, options },
    { code: `${imports}<PopoverTrigger render={<button className="rounded-md bg-card" />} />`, options },
    { code: `${imports}<Squircle className="size-10 bg-card" />`, options },
    { code: `<Link className={buttonVariants({ variant: 'ghost', size: 'sm' })} />` },
    { code: `<Link className={cn(buttonVariants({ variant: 'ghost' }), 'w-full justify-start')} />` },
  ],
  invalid: [
    {
      code: `${imports}<Button className="size-8 rounded-full bg-card" />`,
      options,
      errors: [{ messageId: 'primitive' }],
    },
    {
      code: `${imports}<Button className={cn('w-full', active ? 'bg-secondary' : 'hover:bg-accent')} />`,
      options,
      errors: [{ messageId: 'primitive' }],
    },
    {
      code: `${imports}<PopoverContent className="w-80 p-2" />`,
      options,
      errors: [{ messageId: 'primitive' }],
    },
    {
      code: `${imports}<Button render={<Link className="h-9 font-medium" />} />`,
      options,
      errors: [{ messageId: 'primitive' }],
    },
    {
      code: `<Link className={cn(buttonVariants({ variant: 'ghost' }), 'h-9 hover:bg-accent')} />`,
      errors: [{ messageId: 'recipe' }],
    },
    {
      code: `<a className={buttonVariants({ variant: 'ghost', className: 'rounded-full' })} />`,
      errors: [{ messageId: 'recipe' }],
    },
  ],
})

tester.run('design/no-lookalike', designPlugin.rules['no-lookalike'], {
  valid: [
    `<input type="file" hidden />`,
    `<a href="/terms" className="text-primary underline-offset-4 hover:underline">x</a>`,
    `<a className={buttonVariants({ variant: 'secondary' })} href="#" />`,
    `<Trigger render={<a href="#" className="rounded-md" />} />`,
    `<div className="flex gap-2" />`,
  ],
  invalid: [
    { code: `<button type="button" />`, errors: [{ messageId: 'element' }] },
    { code: `<Trigger render={<button className="rounded-md" />} />`, errors: [{ messageId: 'element' }] },
    { code: `<input type="checkbox" />`, errors: [{ messageId: 'element' }] },
    { code: `<textarea />`, errors: [{ messageId: 'element' }] },
    { code: `<a href="#" className="rounded-md px-2 hover:bg-accent" />`, errors: [{ messageId: 'link' }] },
    { code: `<div onClick={open} className="cursor-pointer" />`, errors: [{ messageId: 'interactive' }] },
  ],
})

tester.run('design/no-hardcoded-text', designPlugin.rules['no-hardcoded-text'], {
  valid: [
    `<p>{t('title')}</p>`,
    `<span>{count} · {total}</span>`,
    `<img alt="" />`,
    { code: `<span>syrnike13</span>`, options: [{ allow: ['syrnike13'] }] },
  ],
  invalid: [
    { code: `<p>\n  Личные сообщения\n</p>`, errors: [{ messageId: 'text' }] },
    { code: `<p>Direct messages</p>`, errors: [{ messageId: 'text' }] },
    { code: `<p>{'Close'}</p>`, errors: [{ messageId: 'text' }] },
    { code: `<button aria-label="Close" />`, errors: [{ messageId: 'text' }] },
    { code: `<Input placeholder={'Search'} />`, errors: [{ messageId: 'text' }] },
  ],
})

const directiveTester = new RuleTester({
  plugins: { design: designPlugin },
  languageOptions: { parser: tsParser },
})

directiveTester.run('design/require-disable-reason', designPlugin.rules['require-disable-reason'], {
  valid: [
    `// eslint-disable-next-line design/no-lookalike -- emoji grid cell, measured by the picker\nconst a = 1`,
    `// eslint-disable-next-line no-console\nconst a = 1`,
  ],
  invalid: [
    { code: `// eslint-disable-next-line design/no-restyle\nconst a = 1`, errors: [{ messageId: 'reason' }] },
    { code: `/* eslint-disable design/no-restyle -- whole file */\nconst a = 1`, errors: [{ messageId: 'fileWide' }] },
  ],
})

const cssTester = new RuleTester({
  plugins: { css },
  language: 'css/css',
  languageOptions: { tolerant: true },
})

cssTester.run('design-css/no-primitive-selectors', designCssPlugin.rules['no-primitive-selectors'], {
  valid: ['.auth-card { gap: 0; }', "[data-theme='dark'] .x { color: var(--foreground); }"],
  invalid: [
    { code: ".auth-card [data-slot='button'] { min-height: 2.75rem; }", errors: [{ messageId: 'selector' }] },
  ],
})

cssTester.run('design-css/no-raw-colors', designCssPlugin.rules['no-raw-colors'], {
  valid: [':root { --shadow-color: oklch(0 0 0); }', '.a { color: var(--muted-foreground); }'],
  invalid: [
    { code: '.a { color: #fff; }', errors: [{ messageId: 'color' }] },
    { code: '.a { box-shadow: 0 0 0 1px rgb(0 0 0 / 10%); }', errors: [{ messageId: 'color' }] },
  ],
})

describe('surfaced primitives in packages/ui', () => {
  const modules = loadSurfacedPrimitives(
    join(import.meta.dirname, '..', '..', 'packages', 'ui', 'src', 'primitives'),
  )
  const surfaced = (module, name) => modules.get(`@syrnike13/ui/primitives/${module}`)?.has(name)

  it('treats components with their own look as surfaced', () => {
    assert.ok(surfaced('button', 'Button'))
    assert.ok(surfaced('popover', 'PopoverContent'))
    assert.ok(surfaced('sidebar', 'SidebarMenuButton'))
    assert.ok(surfaced('dropdown-menu', 'DropdownMenuItem'))
    assert.ok(surfaced('dialog', 'DialogContent'))
  })

  it('leaves unstyled wrappers free', () => {
    assert.ok(!surfaced('popover', 'PopoverTrigger'))
    assert.ok(!surfaced('squircle', 'Squircle'))
    assert.ok(!surfaced('dialog', 'DialogTrigger'))
  })
})
