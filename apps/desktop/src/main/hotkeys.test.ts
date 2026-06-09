import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}))

describe('desktop hotkeys', () => {
  it('preserves valid codes-based combos', async () => {
    const { sanitizeHotkeyBindings } = await import('./hotkeys')

    expect(
      sanitizeHotkeyBindings([
        {
          id: 'valid',
          action: 'push-to-talk',
          enabled: true,
          combo: { codes: ['KeyM', 'ControlRight'] },
        },
      ]),
    ).toEqual([
      {
        id: 'valid',
        action: 'push-to-talk',
        enabled: true,
        combo: { codes: ['ControlRight', 'KeyM'] },
      },
    ])
  })

  it('returns null combo for empty codes arrays', async () => {
    const { sanitizeHotkeyBindings } = await import('./hotkeys')

    expect(
      sanitizeHotkeyBindings([
        {
          id: 'empty',
          action: 'toggle-mic',
          enabled: true,
          combo: { codes: [] },
        },
      ]),
    ).toEqual([
      {
        id: 'empty',
        action: 'toggle-mic',
        enabled: true,
        combo: null,
      },
    ])
  })

  it('returns null combo for non-string codes', async () => {
    const { sanitizeHotkeyBindings } = await import('./hotkeys')

    expect(
      sanitizeHotkeyBindings([
        {
          id: 'bad-codes',
          action: 'toggle-mic',
          enabled: true,
          combo: { codes: ['ControlRight', 1, 'KeyM'] },
        },
      ]),
    ).toEqual([
      {
        id: 'bad-codes',
        action: 'toggle-mic',
        enabled: true,
        combo: null,
      },
    ])
  })

  it('skips bindings with unknown actions', async () => {
    const { sanitizeHotkeyBindings } = await import('./hotkeys')

    expect(
      sanitizeHotkeyBindings([
        {
          id: 'valid',
          action: 'push-to-talk',
          enabled: true,
          combo: { codes: ['ControlRight'] },
        },
        {
          id: 'unknown',
          action: 'launch-missiles',
          enabled: true,
          combo: { codes: ['KeyM'] },
        },
      ]),
    ).toEqual([
      {
        id: 'valid',
        action: 'push-to-talk',
        enabled: true,
        combo: { codes: ['ControlRight'] },
      },
    ])
  })

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
