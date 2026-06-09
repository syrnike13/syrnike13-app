import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}))

describe('desktop hotkeys', () => {
  it('rejects legacy trigger/modifier combos', async () => {
    const { sanitizeHotkeyBindings } = await import('./hotkeys')

    expect(
      sanitizeHotkeyBindings([
        {
          id: 'legacy',
          action: 'push-to-talk',
          enabled: true,
          combo: {
            trigger: { type: 'keyboard', code: 'KeyM', key: 'M' },
            modifiers: { ctrl: true, alt: false, shift: false, meta: false },
          },
        },
      ]),
    ).toEqual([
      {
        id: 'legacy',
        action: 'push-to-talk',
        enabled: true,
        combo: null,
      },
    ])
  })
})
