import { describe, expect, it } from 'vitest'

import { prepareMessageMarkdown } from './entity-markdown-bridge'

describe('prepareMessageMarkdown', () => {
  it('bridges mass mentions with the same token boundaries as the backend', () => {
    expect(prepareMessageMarkdown('@everyone привет')).toContain(
      'syrnike:mass:everyone',
    )
    expect(prepareMessageMarkdown('mail@everyone.example')).toContain(
      'syrnike:mass:everyone',
    )
    expect(prepareMessageMarkdown('status@online')).toContain(
      'syrnike:mass:online',
    )
  })

  it('does not bridge mentions inside code or after an escape', () => {
    const user = '01FD58YK5W7QRV5H3D64KTQYX3'
    expect(prepareMessageMarkdown(`\`<@${user}> @everyone\``)).toBe(
      `\`<@${user}> @everyone\``,
    )
    expect(prepareMessageMarkdown('```\n@everyone\n```')).toBe(
      '```\n@everyone\n```',
    )
    expect(prepareMessageMarkdown('\\@everyone')).toBe('\\@everyone')
    expect(prepareMessageMarkdown(`\\<@${user}>`)).toBe(`\\<@${user}>`)
    expect(prepareMessageMarkdown('\\`@everyone`')).toContain(
      'syrnike:mass:everyone',
    )
  })
})
