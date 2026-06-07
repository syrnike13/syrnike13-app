import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastWarning = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: toastWarning,
  },
}))

import {
  notifyDenoiseUnavailableOnce,
  resetDenoiseUnavailableNotify,
} from './voice-mic-denoise-notify'

describe('notifyDenoiseUnavailableOnce', () => {
  beforeEach(() => {
    toastWarning.mockReset()
    resetDenoiseUnavailableNotify()
  })

  it('shows a warning only once per voice session', () => {
    notifyDenoiseUnavailableOnce()
    notifyDenoiseUnavailableOnce()

    expect(toastWarning).toHaveBeenCalledTimes(1)
  })

  it('can show the warning again after reset', () => {
    notifyDenoiseUnavailableOnce()
    resetDenoiseUnavailableNotify()
    notifyDenoiseUnavailableOnce()

    expect(toastWarning).toHaveBeenCalledTimes(2)
  })
})
