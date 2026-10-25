import { describe, expect, it } from 'vitest'

import {
  computeEffectiveDeafened,
  deafenToggleCommand,
  micToggleCommand,
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

  it('ends a check from the microphone control and keeps the saved mute', () => {
    const idle = { userMuted: false, userDeafened: false, selfMonitoringActive: false }
    expect(micToggleCommand({ ...idle, selfMonitoringActive: true })).toEqual({
      type: 'setSelfMonitoringActive',
      active: false,
    })
    expect(
      micToggleCommand({ ...idle, userMuted: true, selfMonitoringActive: true }),
    ).toEqual({ type: 'setSelfMonitoringActive', active: false })
    expect(
      micToggleCommand({ ...idle, userDeafened: true, selfMonitoringActive: true }),
    ).toEqual({ type: 'setUserDeafened', deafened: false })
    expect(micToggleCommand(idle)).toEqual({ type: 'setUserMuted', muted: true })
  })
})
