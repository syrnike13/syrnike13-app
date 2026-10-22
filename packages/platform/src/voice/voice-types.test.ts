import { describe, expect, it } from 'vitest'

import {
  computeEffectiveDeafened,
  deafenToggleCommand,
  reportedSelfVoiceFlags,
} from './voice-types'

describe('self-monitoring voice flags', () => {
  it('deafens and reports a check without changing the saved flags', () => {
    const state = {
      userMuted: false,
      userDeafened: false,
      serverDeafened: false,
      selfMonitoringActive: true,
    }
    expect(computeEffectiveDeafened(state)).toBe(true)
    expect(reportedSelfVoiceFlags(state)).toEqual({
      userMuted: false,
      userDeafened: true,
    })
  })

  it('ends a check from the deafen control instead of saving a deafen', () => {
    expect(
      deafenToggleCommand({ userDeafened: false, selfMonitoringActive: true }),
    ).toEqual({ type: 'setSelfMonitoringActive', active: false })
    expect(
      deafenToggleCommand({ userDeafened: true, selfMonitoringActive: true }),
    ).toEqual({ type: 'setUserDeafened', deafened: false })
    expect(
      deafenToggleCommand({ userDeafened: false, selfMonitoringActive: false }),
    ).toEqual({ type: 'setUserDeafened', deafened: true })
  })
})
