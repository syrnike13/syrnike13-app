// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Effect } from 'effect'
import { createTranslator } from '@syrnike13/ui/i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ru from '#/messages/ru.json'
import { VoiceRtcDebugView } from '#/components/voice/voice-rtc-debug-view'
import type { RtcDebugSnapshot } from '#/features/voice/voice-rtc-debug'

const t = createTranslator(ru, 'ru', 'voice')

const setRtcDebugEnabled = vi.fn()
let voiceState: Record<string, unknown>

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    user: { _id: 'local-user' },
  }),
}))

vi.mock('#/features/voice/voice-node', () => ({
  resolveVoiceNodeName: () => Promise.resolve('worldwide'),
  resolveVoiceNodeNameEffect: Effect.succeed('worldwide'),
}))

vi.mock('#/features/voice/voice-session-context', () => ({
  useVoiceSession: () => voiceState,
}))

vi.mock('#/features/voice/voice-stage-context', () => ({
  useVoiceStage: () => voiceState,
}))

vi.mock('#/features/voice/voice-telemetry-context', () => ({
  useVoiceTelemetry: () => voiceState,
}))

const snapshot: RtcDebugSnapshot = {
  timestamp: 1_000,
  transport: {
    availableOutgoingBitrate: 6_000_000,
    availableIncomingBitrate: 7_000_000,
    pingMs: 63,
    localAddress: '10.0.0.2:50100/udp',
    remoteAddress: '195.209.213.95:443/udp',
    bytesSent: 1_200,
    bytesReceived: 2_400,
    packetsSent: 12,
    packetsReceived: 24,
  },
  outbound: [
    {
      id: 'publisher:video',
      pcRole: 'publisher',
      kind: 'video',
      ssrc: 111,
      codec: 'VP8 (96)',
      bytesSent: 500_000,
      packetsSent: 450,
      framesPerSecond: 60,
      frameWidth: 1920,
      frameHeight: 1080,
      qualityLimitationReason: 'none',
    },
  ],
  inbound: [
    {
      id: 'subscriber:video',
      pcRole: 'subscriber',
      kind: 'video',
      ssrc: 222,
      codec: 'VP8 (96)',
      bytesReceived: 750_000,
      packetsReceived: 700,
      packetsLost: 0,
      framesPerSecond: 55,
      frameWidth: 1920,
      frameHeight: 1080,
    },
  ],
  screenShares: [
    {
      id: 'remote-user:screen',
      ownerUserId: 'remote-user',
      isLocal: false,
      subscribed: true,
      live: true,
      trackReady: true,
      publicationId: 'TR_screen',
      codec: 'vp8',
      maxBitrate: 8_000_000,
      maxFramerate: 60,
      simulcast: false,
      degradationPreference: 'maintain-resolution',
      captureWidth: 1920,
      captureHeight: 1080,
      captureFrameRate: 60,
      displaySurface: 'monitor',
      contentHint: 'motion',
      hybridDxgiFrames: 'N/A',
      hybridGdiBitBltFrames: 'N/A',
      hybridGdiPrintWindowFrames: 'N/A',
      hybridGraphicsCaptureFrames: 'N/A',
      hybridVideohookFrames: 'N/A',
    },
  ],
  rates: {
    transport: {
      outboundBitrate: 4_000,
      inboundBitrate: 8_000,
    },
    outbound: {
      'publisher:video': 8_000,
    },
    inbound: {
      'subscriber:video': 16_000,
    },
    quality: {},
  },
}

describe('VoiceRtcDebugView', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    setRtcDebugEnabled.mockClear()
    voiceState = {
      status: 'connected',
      setRtcDebugEnabled,
      rtcDebugSnapshot: snapshot,
      rtcDebugHistory: [snapshot],
      channelId: 'voice-channel',
      participantCount: 2,
      stageMediaItems: [{ id: 'remote-user:screen' }],
    }
  })

  it('shows empty state without active voice connection', () => {
    voiceState = {
      ...voiceState,
      status: 'idle',
      rtcDebugSnapshot: null,
      rtcDebugHistory: [],
    }

    render(<VoiceRtcDebugView />)

    expect(screen.getByText(t('debug.noVoiceTitle'))).toBeTruthy()
    expect(setRtcDebugEnabled).toHaveBeenCalledWith(true)
  })

  it('renders debug sections from a snapshot', () => {
    render(<VoiceRtcDebugView />)

    expect(screen.getByText(t('debug.selectedIceCandidate'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t('debug.transport') }))
    expect(screen.getByText(t('debug.availableOutgoingBitrate'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t('debug.outgoing') }))
    fireEvent.click(screen.getByRole('button', { name: t('debug.video') }))
    expect(screen.getByText(t('debug.qualityLimitationReason'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t('debug.screenShare') }))
    expect(screen.getByText(t('debug.hybridDxgiFrames'))).toBeTruthy()
    expect(screen.getByText('TR_screen')).toBeTruthy()
  })
})
