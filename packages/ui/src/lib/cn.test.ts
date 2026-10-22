import { expect, test } from 'vitest'

import { cn } from './cn'

test('merges conflicting Tailwind classes', () => {
  expect(cn('px-2', 'px-4')).toBe('px-4')
})

test('drops falsy values', () => {
  expect(cn('text-foreground', false, undefined, null)).toBe('text-foreground')
})
