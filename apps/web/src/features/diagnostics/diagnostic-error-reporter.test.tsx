// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  enqueue: vi.fn(),
  lease: vi.fn(),
  record: vi.fn(),
  release: vi.fn(),
  send: vi.fn(),
  session: { token: 'token', user_id: 'account-a' },
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({ session: testState.session }),
}))

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({
    desktop: {
      diagnostics: {
        acknowledgeNativeIncidents: testState.acknowledge,
        enqueueIncident: testState.enqueue,
        leaseNativeIncidents: testState.lease,
        releaseNativeIncidents: testState.release,
      },
    },
  }),
}))

vi.mock('./diagnostic-reporter', () => ({
  recordDiagnosticEvent: testState.record,
  sendDiagnosticReport: testState.send,
}))

import { DiagnosticErrorReporter } from './diagnostic-error-reporter'
import {
  clearAutomaticDiagnosticIncidentsForTests,
  enqueueAutomaticDiagnosticIncident,
} from './automatic-diagnostic-incidents'

describe('DiagnosticErrorReporter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testState.session = { token: 'token', user_id: 'account-a' }
    clearAutomaticDiagnosticIncidentsForTests()
    testState.lease.mockResolvedValue({
      id: 'batch-1',
      accountId: 'account-a',
      incidents: [
        {
          timestampMs: 1,
          severity: 'error',
          triggerCode: 'desktop-voice.runtime_failed',
          scope: 'desktop-voice',
          event: 'runtime_failed',
        },
      ],
    })
    testState.send.mockResolvedValue(null)
    testState.enqueue.mockResolvedValue(true)
    testState.release.mockResolvedValue(true)
  })

  it('deduplicates an incident batch that is re-leased during cooldown', async () => {
    const view = render(<DiagnosticErrorReporter />)

    await waitFor(() => expect(testState.record).toHaveBeenCalled())
    expect(testState.record).toHaveBeenCalledWith(
      'native-runtime',
      'instability_detected',
      expect.objectContaining({ event: 'runtime_failed' }),
      {
        dedupeKey: 'native-runtime:desktop-voice:desktop-voice.runtime_failed',
        heartbeatMs: 60_000,
      },
    )
    await waitFor(() => expect(testState.release).toHaveBeenCalledWith('account-a', 'batch-1'))

    view.unmount()
  })

  it('is the single automatic upload owner for renderer producers', async () => {
    testState.lease.mockResolvedValue(null)
    testState.send.mockResolvedValue({ id: 'report', created_at: 1 })
    const view = render(<DiagnosticErrorReporter />)

    enqueueAutomaticDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
      context: { stage: 'native_runtime' },
    })

    await waitFor(() => expect(testState.enqueue).toHaveBeenCalledWith('account-a', {
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
      cooldownMs: undefined,
    }))
    expect(testState.send).not.toHaveBeenCalled()
    view.unmount()
  })

  it('does not execute queued incidents after the account owner changes', async () => {
    testState.lease.mockResolvedValue(null)
    let releaseFirst!: () => void
    testState.enqueue.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirst = resolve
    }))
    const view = render(<DiagnosticErrorReporter />)

    enqueueAutomaticDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'first',
    })
    enqueueAutomaticDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'queued',
    })
    await waitFor(() => expect(testState.enqueue).toHaveBeenCalledTimes(1))

    testState.session = { token: 'token-b', user_id: 'account-b' }
    view.rerender(<DiagnosticErrorReporter />)
    releaseFirst()
    await Promise.resolve()
    await Promise.resolve()

    expect(testState.enqueue).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('keeps a delayed A lease out of B acknowledgement and release calls', async () => {
    let resolveLease!: (batch: {
      id: string
      accountId: string
      incidents: Array<{
        timestampMs: number
        severity: 'error'
        triggerCode: string
        scope: string
        event: string
      }>
    } | null) => void
    testState.lease
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveLease = resolve
      }))
      .mockResolvedValue(null)
    const view = render(<DiagnosticErrorReporter />)
    await waitFor(() => expect(testState.lease).toHaveBeenCalledWith('account-a'))

    testState.session = { token: 'token-b', user_id: 'account-b' }
    view.rerender(<DiagnosticErrorReporter />)
    await waitFor(() => expect(testState.lease).toHaveBeenCalledWith('account-b'))
    resolveLease({
      id: 'batch-a',
      accountId: 'account-a',
      incidents: [
        {
          timestampMs: 1,
          severity: 'error',
          triggerCode: 'desktop-voice.runtime_failed',
          scope: 'desktop-voice',
          event: 'runtime_failed',
        },
      ],
    })

    await waitFor(() => {
      expect(testState.release).toHaveBeenCalledWith('account-a', 'batch-a')
    })
    expect(testState.acknowledge).not.toHaveBeenCalled()
    expect(testState.release).not.toHaveBeenCalledWith('account-b', 'batch-a')
    view.unmount()
  })

  it('does not acknowledge or release a batch returned for another account', async () => {
    testState.lease.mockResolvedValue({
      id: 'batch-b',
      accountId: 'account-b',
      incidents: [
        {
          timestampMs: 1,
          severity: 'error',
          triggerCode: 'desktop-voice.runtime_failed',
          scope: 'desktop-voice',
          event: 'runtime_failed',
        },
      ],
    })
    const view = render(<DiagnosticErrorReporter />)

    await waitFor(() => expect(testState.lease).toHaveBeenCalledWith('account-a'))
    await Promise.resolve()

    expect(testState.record).not.toHaveBeenCalled()
    expect(testState.acknowledge).not.toHaveBeenCalled()
    expect(testState.release).not.toHaveBeenCalled()
    view.unmount()
  })
})
