// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  lease: vi.fn(),
  record: vi.fn(),
  release: vi.fn(),
  send: vi.fn(),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({ session: { token: 'token' } }),
}))

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({
    desktop: {
      diagnostics: {
        acknowledgeNativeIncidents: testState.acknowledge,
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

describe('DiagnosticErrorReporter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testState.lease.mockResolvedValue({
      id: 'batch-1',
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
    await waitFor(() => expect(testState.release).toHaveBeenCalledWith('batch-1'))

    view.unmount()
  })
})
