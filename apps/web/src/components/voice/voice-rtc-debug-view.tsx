import { useEffect, useState, type ReactNode } from 'react'
import { Effect, Fiber } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import { RtcDebugMetricChart } from '#/components/voice/voice-rtc-debug-chart'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@syrnike13/ui/primitives/empty'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { resolveVoiceNodeNameEffect } from '#/features/voice/voice-node'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { useVoiceTelemetry } from '#/features/voice/voice-telemetry-context'
import {
  RTC_DEBUG_BROWSER_UNAVAILABLE,
  formatRtcBitrate,
  formatRtcBytes,
  formatRtcFps,
  formatRtcInteger,
  formatRtcMs,
  formatRtcPercent,
  formatRtcValue,
  rtcConnectionQuality,
  type RtcConnectionQuality,
  type RtcDebugRtpStreamSnapshot,
  type RtcDebugSnapshot,
} from '#/features/voice/voice-rtc-debug'
import { cn } from '#/lib/utils'

type DebugSection = 'general' | 'transport' | 'outgoing' | 'incoming' | 'screen'
type MediaTab = 'audio' | 'video'

const sections: Array<{ id: DebugSection; labelKey: string }> = [
  { id: 'general', labelKey: 'debug.general' },
  { id: 'transport', labelKey: 'debug.transport' },
  { id: 'outgoing', labelKey: 'debug.outgoing' },
  { id: 'incoming', labelKey: 'debug.incoming' },
  { id: 'screen', labelKey: 'debug.screenShare' },
]

export function VoiceRtcDebugView() {
  const t = useTranslations('voice')
  const voiceSession = useVoiceSession()
  const voiceStage = useVoiceStage()
  const voiceTelemetry = useVoiceTelemetry()
  const auth = useAuth()
  const { setRtcDebugEnabled } = voiceTelemetry
  const [section, setSection] = useState<DebugSection>('general')
  const [nodeName, setNodeName] = useState<string | null>(null)

  useEffect(() => {
    setRtcDebugEnabled(true)
    return () => setRtcDebugEnabled(false)
  }, [setRtcDebugEnabled])

  useEffect(() => {
    const fiber = Effect.runFork(
      resolveVoiceNodeNameEffect.pipe(
        Effect.tap((name) =>
          Effect.sync(() => {
            setNodeName(name)
          }),
        ),
      ),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])

  const snapshot = voiceTelemetry.rtcDebugSnapshot

  return (
    <div className="gradient-surface-content flex min-h-0 flex-1 flex-col bg-card text-card-foreground lg:flex-row">
      <aside className="gradient-surface-navigation shrink-0 border-b border-border bg-sidebar px-4 py-4 text-sidebar-foreground lg:w-60 lg:border-r lg:border-b-0 lg:px-5 lg:py-8">
        <div className="mb-4 lg:mb-6">
          <h1 className="text-lg font-bold leading-none">{t('debug.title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {voiceSession.status === 'connected'
              ? t('debug.connected')
              : t('debug.disconnected')}
          </p>
        </div>

        <p className="mb-2 hidden text-xs font-bold uppercase text-muted-foreground lg:block">
          {t('debug.sections')}
        </p>
        <nav className="flex gap-1 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0">
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={cn(
                'flex h-9 shrink-0 items-center rounded px-3 text-left text-sm font-semibold text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground lg:w-full',
                section === item.id &&
                  'bg-sidebar-accent text-sidebar-accent-foreground',
              )}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {voiceSession.status !== 'connected' ? (
              <DebugEmptyState />
            ) : (
              <DebugSectionBody
                section={section}
                snapshot={snapshot}
                history={voiceTelemetry.rtcDebugHistory}
                nodeName={nodeName}
                localIdentity={auth.user?._id ?? null}
                channelId={voiceSession.channelId}
                participantCount={voiceSession.participantCount}
                stageMediaCount={voiceStage.stageMediaItems.length}
              />
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

function DebugSectionBody({
  section,
  snapshot,
  history,
  nodeName,
  localIdentity,
  channelId,
  participantCount,
  stageMediaCount,
}: {
  section: DebugSection
  snapshot: RtcDebugSnapshot | null
  history: readonly RtcDebugSnapshot[]
  nodeName: string | null
  localIdentity: string | null
  channelId: string | null
  participantCount: number
  stageMediaCount: number
}) {
  const t = useTranslations('voice')

  if (!snapshot) {
    return (
      <div className="rounded border border-dashed border-border px-6 py-12">
        <Empty size="inline">
          <EmptyHeader>
            <EmptyTitle>{t('debug.collectingTitle')}</EmptyTitle>
            <EmptyDescription>{t('debug.collectingHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  if (section === 'general') {
    return (
      <GeneralSection
        snapshot={snapshot}
        history={history}
        nodeName={nodeName}
        localIdentity={localIdentity}
        channelId={channelId}
        participantCount={participantCount}
        stageMediaCount={stageMediaCount}
      />
    )
  }

  if (section === 'transport') {
    return <TransportSection snapshot={snapshot} history={history} nodeName={nodeName} />
  }

  if (section === 'outgoing') {
    return (
      <RtpSection
        title={t('debug.outgoing')}
        streams={snapshot.outbound}
        history={history}
        direction="outbound"
      />
    )
  }

  if (section === 'incoming') {
    return (
      <RtpSection
        title={t('debug.incoming')}
        streams={snapshot.inbound}
        history={history}
        direction="inbound"
      />
    )
  }

  return <ScreenShareSection snapshot={snapshot} history={history} />
}

function GeneralSection({
  snapshot,
  history,
  nodeName,
  localIdentity,
  channelId,
  participantCount,
  stageMediaCount,
}: {
  snapshot: RtcDebugSnapshot
  history: readonly RtcDebugSnapshot[]
  nodeName: string | null
  localIdentity: string | null
  channelId: string | null
  participantCount: number
  stageMediaCount: number
}) {
  const t = useTranslations('voice')
  const quality = rtcConnectionQuality(snapshot)
  const rates = snapshot.rates

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-foreground">
            {t('debug.connectionState')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {snapshot.source === 'windows_native'
              ? t('debug.sourceWindowsNative')
              : t('debug.sourceBrowser')}
          </p>
        </div>
        <QualityBadge quality={quality} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <OverviewCard
          label={t('debug.ping')}
          value={formatRtcMs(snapshot.transport.pingMs)}
          history={history}
          metric={(sample) => sample.transport.pingMs}
        />
        <OverviewCard
          label={t('debug.packetLoss')}
          value={formatRtcPercent(rates?.quality.packetLossPercent)}
          history={history}
          metric={(sample) => sample.rates?.quality.packetLossPercent}
        />
        <OverviewCard
          label={t('debug.jitter')}
          value={formatRtcMs(rates?.quality.jitterMs)}
          history={history}
          metric={(sample) => sample.rates?.quality.jitterMs}
        />
        <OverviewCard
          label={t('debug.frameDrop')}
          value={formatRtcPercent(rates?.quality.framesDroppedPercent)}
          detail={
            rates?.quality.framesDroppedPerSecond == null
              ? undefined
              : t('debug.frameDropRate', {
                  rate: rates.quality.framesDroppedPerSecond.toFixed(1),
                })
          }
          history={history}
          metric={(sample) => sample.rates?.quality.framesDroppedPercent}
        />
        <OverviewCard
          label={t('debug.incomingStream')}
          value={formatRtcBitrate(rates?.transport.inboundBitrate)}
          history={history}
          metric={(sample) => sample.rates?.transport.inboundBitrate}
        />
        <OverviewCard
          label={t('debug.outgoingStream')}
          value={formatRtcBitrate(rates?.transport.outboundBitrate)}
          history={history}
          metric={(sample) => sample.rates?.transport.outboundBitrate}
        />
      </div>

      <div className="mt-8">
        <MetricGrid title={t('debug.session')}>
          <MetricRow label={t('debug.voiceNode')} value={nodeName ?? '—'} />
          <MetricRow label={t('debug.channel')} value={channelId ?? '—'} />
          <MetricRow
            label={t('debug.localIdentity')}
            value={localIdentity ?? '—'}
          />
          <MetricRow
            label={t('debug.participantCount')}
            value={participantCount}
          />
          <MetricRow
            label={t('debug.stageMediaItems')}
            value={stageMediaCount}
          />
          <MetricRow
            label={t('debug.selectedIceCandidate')}
            value={snapshot.transport.selectedCandidatePairId ?? '—'}
          />
          <MetricRow
            label={t('debug.hiddenAudioSamples')}
            value={formatRtcPercent(rates?.quality.concealedAudioPercent)}
          />
          <MetricRow
            label={t('debug.statsSource')}
            value={snapshot.source ?? 'web'}
          />
        </MetricGrid>
      </div>
    </div>
  )
}

function TransportSection({
  snapshot,
  history,
  nodeName,
}: {
  snapshot: RtcDebugSnapshot
  history: readonly RtcDebugSnapshot[]
  nodeName: string | null
}) {
  const t = useTranslations('voice')

  return (
    <MetricGrid title={t('debug.dataTransfer')}>
      <MetricRow
        label={t('debug.availableOutgoingBitrate')}
        value={formatRtcBitrate(snapshot.transport.availableOutgoingBitrate)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.availableOutgoingBitrate} />}
      />
      <MetricRow
        label={t('debug.availableIncomingBitrate')}
        value={formatRtcBitrate(snapshot.transport.availableIncomingBitrate)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.availableIncomingBitrate} />}
      />
      <MetricRow
        label={t('debug.ping')}
        value={formatRtcMs(snapshot.transport.pingMs)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.pingMs} />}
      />
      <MetricRow
        label={t('debug.localAddress')}
        value={snapshot.transport.localAddress ?? '—'}
      />
      <MetricRow
        label={t('debug.remoteAddress')}
        value={snapshot.transport.remoteAddress ?? '—'}
      />
      <MetricRow
        label={t('debug.pacerDelay')}
        value={RTC_DEBUG_BROWSER_UNAVAILABLE}
      />
      <MetricRow
        label={t('debug.outboundBitrateEstimate')}
        value={formatRtcBitrate(snapshot.rates?.transport.outboundBitrate)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.rates?.transport.outboundBitrate} />}
      />
      <MetricRow
        label={t('debug.inboundBitrateEstimate')}
        value={formatRtcBitrate(snapshot.rates?.transport.inboundBitrate)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.rates?.transport.inboundBitrate} />}
      />
      <MetricRow
        label={t('debug.packetsReceived')}
        value={formatRtcInteger(snapshot.transport.packetsReceived)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.packetsReceived} />}
      />
      <MetricRow
        label={t('debug.packetsSent')}
        value={formatRtcInteger(snapshot.transport.packetsSent)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.packetsSent} />}
      />
      <MetricRow
        label={t('debug.bytesReceived')}
        value={formatRtcBytes(snapshot.transport.bytesReceived)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.bytesReceived} />}
      />
      <MetricRow
        label={t('debug.bytesSent')}
        value={formatRtcBytes(snapshot.transport.bytesSent)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.bytesSent} />}
      />
      <MetricRow label={t('debug.hostname')} value={nodeName ?? '—'} />
    </MetricGrid>
  )
}

function RtpSection({
  title,
  streams,
  history,
  direction,
}: {
  title: string
  streams: readonly RtcDebugRtpStreamSnapshot[]
  history: readonly RtcDebugSnapshot[]
  direction: 'outbound' | 'inbound'
}) {
  const t = useTranslations('voice')
  const [tab, setTab] = useState<MediaTab>('audio')
  const filtered = streams.filter((stream) => stream.kind === tab)

  return (
    <div>
      <SectionHeader title={title} />
      <MediaTabs value={tab} onChange={setTab} />
      {filtered.length === 0 ? (
        <EmptyPanel
          text={tab === 'audio' ? t('debug.noAudioRtp') : t('debug.noVideoRtp')}
        />
      ) : (
        <div className="grid grid-cols-1 gap-x-8 gap-y-7 xl:grid-cols-2">
          {filtered.map((stream) => (
            <RtpStreamCard
              key={stream.id}
              stream={stream}
              history={history}
              direction={direction}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RtpStreamCard({
  stream,
  history,
  direction,
}: {
  stream: RtcDebugRtpStreamSnapshot
  history: readonly RtcDebugSnapshot[]
  direction: 'outbound' | 'inbound'
}) {
  const t = useTranslations('voice')
  const rate = (sample: RtcDebugSnapshot) =>
    direction === 'outbound'
      ? sample.rates?.outbound[stream.id]
      : sample.rates?.inbound[stream.id]
  const lastSample = history[history.length - 1]
  const currentRate = lastSample ? rate(lastSample) : undefined

  return (
    <MetricGroup title={`${stream.pcRole} / ${stream.kind} / ${stream.mid ?? stream.ssrc ?? stream.id}`}>
      <MetricRow label="SSRC" value={formatRtcValue(stream.ssrc)} />
      <MetricRow label="MID" value={stream.mid ?? '—'} />
      <MetricRow label={t('debug.codec')} value={stream.codec ?? '—'} />
      <MetricRow
        label={t('debug.bitrate')}
        value={formatRtcBitrate(currentRate)}
        chart={<RtcDebugMetricChart history={history} value={rate} />}
      />
      <MetricRow
        label={t('debug.bitrateTarget')}
        value={formatRtcBitrate(stream.targetBitrate)}
      />
      <MetricRow
        label={t('debug.packetsSent')}
        value={formatRtcInteger(stream.packetsSent)}
      />
      <MetricRow
        label={t('debug.packetsReceived')}
        value={formatRtcInteger(stream.packetsReceived)}
      />
      <MetricRow
        label={t('debug.packetsLost')}
        value={formatRtcInteger(stream.packetsLost)}
      />
      <MetricRow
        label={t('debug.packetLoss')}
        value={formatRtcPercent(stream.packetLossPercent)}
      />
      <MetricRow
        label={t('debug.roundTripTime')}
        value={formatRtcMs(stream.roundTripTimeMs)}
      />
      <MetricRow
        label={t('debug.bytesSent')}
        value={formatRtcBytes(stream.bytesSent)}
      />
      <MetricRow
        label={t('debug.bytesReceived')}
        value={formatRtcBytes(stream.bytesReceived)}
      />
      <MetricRow
        label={t('debug.retransmittedPackets')}
        value={formatRtcInteger(
          stream.retransmittedPacketsSent ??
            stream.retransmittedPacketsReceived,
        )}
      />
      <MetricRow
        label={t('debug.retransmittedBytes')}
        value={formatRtcBytes(
          stream.retransmittedBytesSent ?? stream.retransmittedBytesReceived,
        )}
      />
      <MetricRow
        label={t('debug.discardedPackets')}
        value={formatRtcInteger(stream.packetsDiscarded)}
      />
      <MetricRow label="NACK" value={formatRtcInteger(stream.nackCount)} />
      <MetricRow label="FIR" value={formatRtcInteger(stream.firCount)} />
      <MetricRow label="PLI" value={formatRtcInteger(stream.pliCount)} />
      <MetricRow
        label={t('debug.encodeFps')}
        value={formatRtcFps(stream.framesPerSecond)}
      />
      <MetricRow
        label={t('debug.frameSize')}
        value={formatFrameSize(stream.frameWidth, stream.frameHeight)}
      />
      <MetricRow
        label={t('debug.framesSent')}
        value={formatRtcInteger(stream.framesSent)}
      />
      <MetricRow
        label={t('debug.framesReceived')}
        value={formatRtcInteger(stream.framesReceived)}
      />
      <MetricRow
        label={t('debug.framesRendered')}
        value={formatRtcInteger(stream.framesRendered)}
      />
      <MetricRow
        label={t('debug.framesEncoded')}
        value={formatRtcInteger(stream.framesEncoded)}
      />
      <MetricRow
        label={t('debug.framesDecoded')}
        value={formatRtcInteger(stream.framesDecoded)}
      />
      <MetricRow
        label={t('debug.framesDropped')}
        value={formatRtcInteger(stream.framesDropped)}
      />
      <MetricRow
        label={t('debug.freezeCount')}
        value={formatRtcInteger(stream.freezeCount)}
      />
      <MetricRow
        label={t('debug.freezeDuration')}
        value={formatRtcValue(stream.totalFreezesDuration)}
      />
      <MetricRow
        label={t('debug.jitter')}
        value={formatRtcMs(
          stream.jitter == null ? undefined : stream.jitter * 1000,
        )}
      />
      <MetricRow
        label={t('debug.qualityLimitationReason')}
        value={stream.qualityLimitationReason ?? '—'}
      />
      <MetricRow
        label={t('debug.encoder')}
        value={stream.encoderImplementation ?? '—'}
      />
      <MetricRow
        label={t('debug.decoder')}
        value={stream.decoderImplementation ?? '—'}
      />
      <MetricRow
        label={t('debug.audioLevel')}
        value={formatRtcValue(stream.audioLevel)}
      />
      <MetricRow
        label={t('debug.totalAudioEnergy')}
        value={formatRtcValue(stream.totalAudioEnergy)}
      />
      <MetricRow
        label={t('debug.samplesDuration')}
        value={formatRtcValue(stream.totalSamplesDuration)}
      />
      <MetricRow
        label={t('debug.samplesReceived')}
        value={formatRtcInteger(stream.totalSamplesReceived)}
      />
      <MetricRow
        label={t('debug.concealedSamples')}
        value={formatRtcInteger(stream.concealedSamples)}
      />
      <MetricRow
        label={t('debug.silentConcealedSamples')}
        value={formatRtcInteger(stream.silentConcealedSamples)}
      />
      <MetricRow
        label={t('debug.concealmentEvents')}
        value={formatRtcInteger(stream.concealmentEvents)}
      />
      <MetricRow
        label={t('debug.jitterBufferDelay')}
        value={formatRtcValue(stream.jitterBufferDelay)}
      />
      <MetricRow
        label={t('debug.jitterBufferTarget')}
        value={formatRtcValue(stream.jitterBufferTargetDelay)}
      />
      <MetricRow
        label={t('debug.jitterBufferEmitted')}
        value={formatRtcInteger(stream.jitterBufferEmittedCount)}
      />
    </MetricGroup>
  )
}

function ScreenShareSection({
  snapshot,
  history,
}: {
  snapshot: RtcDebugSnapshot
  history: readonly RtcDebugSnapshot[]
}) {
  const t = useTranslations('voice')
  const screenShares = snapshot.screenShares

  return (
    <div>
      <SectionHeader title={t('debug.screenShare')} />
      {screenShares.length === 0 ? (
        <EmptyPanel text={t('debug.noScreenShareTiles')} />
      ) : (
        <div className="grid grid-cols-1 gap-x-8 gap-y-7 xl:grid-cols-2">
          {screenShares.map((share) => (
            <MetricGroup
              key={share.id}
              title={`${share.isLocal ? t('debug.local') : t('debug.remote')} / ${share.ownerUserId}`}
            >
              <MetricRow
                label={t('debug.publicationId')}
                value={share.publicationId ?? '—'}
              />
              <MetricRow label={t('debug.owner')} value={share.ownerUserId} />
              <MetricRow
                label={t('debug.subscribed')}
                value={formatRtcValue(share.subscribed)}
              />
              <MetricRow
                label={t('debug.live')}
                value={formatRtcValue(share.live)}
              />
              <MetricRow
                label={t('debug.captureWidth')}
                value={formatRtcInteger(share.captureWidth)}
              />
              <MetricRow
                label={t('debug.captureHeight')}
                value={formatRtcInteger(share.captureHeight)}
              />
              <MetricRow
                label={t('debug.captureFps')}
                value={formatRtcFps(share.captureFrameRate)}
              />
              <MetricRow
                label={t('debug.displaySurface')}
                value={share.displaySurface ?? '—'}
              />
              <MetricRow
                label={t('debug.cursor')}
                value={share.cursor ?? '—'}
              />
              <MetricRow
                label={t('debug.logicalSurface')}
                value={formatRtcValue(share.logicalSurface)}
              />
              <MetricRow
                label={t('debug.resizeMode')}
                value={share.resizeMode ?? '—'}
              />
              <MetricRow
                label={t('debug.contentHint')}
                value={share.contentHint ?? '—'}
              />
              <MetricRow label={t('debug.codec')} value={share.codec ?? '—'} />
              <MetricRow
                label={t('debug.maxBitrate')}
                value={formatRtcBitrate(share.maxBitrate)}
              />
              <MetricRow
                label={t('debug.maxFramerate')}
                value={formatRtcFps(share.maxFramerate)}
              />
              <MetricRow
                label={t('debug.simulcast')}
                value={formatRtcValue(share.simulcast)}
              />
              <MetricRow
                label={t('debug.degradationPreference')}
                value={share.degradationPreference ?? '—'}
              />
              <MetricRow
                label={t('debug.captureBackend')}
                value={share.captureBackend ?? '—'}
              />
              <MetricRow
                label={t('debug.captureMethod')}
                value={share.captureMethod ?? '—'}
              />
              <MetricRow
                label={t('debug.captureVideoPublished')}
                value={formatRtcValue(share.captureVideoPublished)}
              />
              <MetricRow
                label={t('debug.captureVideoFrames')}
                value={formatRtcInteger(share.captureVideoFrames)}
              />
              <MetricRow
                label={t('debug.captureIntervalFrames')}
                value={formatRtcInteger(share.captureVideoIntervalFrames)}
              />
              <MetricRow
                label={t('debug.captureLateFrames')}
                value={formatRtcInteger(share.captureVideoLateFrames)}
              />
              <MetricRow
                label={t('debug.captureNoFrames')}
                value={formatRtcInteger(share.captureVideoNoFrameCount)}
              />
              <MetricRow
                label={t('debug.captureRepeatedFrames')}
                value={formatRtcInteger(share.captureVideoRepeatedFrameCount)}
              />
              <MetricRow
                label={t('debug.captureRecoverableLost')}
                value={formatRtcInteger(share.captureVideoRecoverableLostCount)}
              />
              <MetricRow
                label={t('debug.avgCapture')}
                value={formatRtcMicroseconds(share.captureVideoAvgCaptureUs)}
              />
              <MetricRow
                label={t('debug.avgReadback')}
                value={formatRtcMicroseconds(share.captureVideoAvgReadbackUs)}
              />
              <MetricRow
                label={t('debug.avgScale')}
                value={formatRtcMicroseconds(share.captureVideoAvgScaleUs)}
              />
              <MetricRow
                label={t('debug.avgPublish')}
                value={formatRtcMicroseconds(share.captureVideoAvgPublishUs)}
              />
              <MetricRow
                label={t('debug.captureSourceSize')}
                value={formatFrameSize(share.captureVideoSourceWidth, share.captureVideoSourceHeight)}
              />
              <MetricRow
                label={t('debug.captureContentSize')}
                value={formatFrameSize(share.captureVideoContentWidth, share.captureVideoContentHeight)}
              />
              <MetricRow
                label={t('debug.captureThreadMmcss')}
                value={formatRtcValue(share.captureThreadMmcss)}
              />
              <MetricRow
                label={t('debug.hybridDxgiFrames')}
                value={formatHybridFrameCount(share.hybridDxgiFrames)}
              />
              <MetricRow
                label={t('debug.hybridGdiBitBltFrames')}
                value={formatHybridFrameCount(share.hybridGdiBitBltFrames)}
              />
              <MetricRow
                label={t('debug.hybridGdiPrintWindowFrames')}
                value={formatHybridFrameCount(share.hybridGdiPrintWindowFrames)}
              />
              <MetricRow
                label={t('debug.hybridGraphicsCaptureFrames')}
                value={formatHybridFrameCount(share.hybridGraphicsCaptureFrames)}
              />
              <MetricRow
                label={t('debug.hybridVideohookFrames')}
                value={RTC_DEBUG_BROWSER_UNAVAILABLE}
              />
              <ScreenShareBitrateRows
                shareId={share.id}
                sentBitrate={share.sentBitrate}
                receivedBitrate={share.receivedBitrate}
                history={history}
              />
            </MetricGroup>
          ))}
        </div>
      )}
    </div>
  )
}

function ScreenShareBitrateRows({
  shareId,
  sentBitrate,
  receivedBitrate,
  history,
}: {
  shareId: string
  sentBitrate?: number
  receivedBitrate?: number
  history: readonly RtcDebugSnapshot[]
}) {
  const t = useTranslations('voice')
  const sentHistoryValue = (sample: RtcDebugSnapshot) =>
    sample.screenShares.find((share) => share.id === shareId)?.sentBitrate
  const receivedHistoryValue = (sample: RtcDebugSnapshot) =>
    sample.screenShares.find((share) => share.id === shareId)?.receivedBitrate

  return (
    <>
      {sentBitrate != null ? (
        <MetricRow
          label={t('debug.liveSentBitrate')}
          value={formatRtcBitrate(sentBitrate)}
          chart={<RtcDebugMetricChart history={history} value={sentHistoryValue} />}
        />
      ) : null}
      {receivedBitrate != null ? (
        <MetricRow
          label={t('debug.liveReceivedBitrate')}
          value={formatRtcBitrate(receivedBitrate)}
          chart={<RtcDebugMetricChart history={history} value={receivedHistoryValue} />}
        />
      ) : null}
    </>
  )
}

function OverviewCard({
  label,
  value,
  detail,
  history,
  metric,
}: {
  label: string
  value: string
  detail?: string
  history: readonly RtcDebugSnapshot[]
  metric: (sample: RtcDebugSnapshot) => number | null | undefined
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="px-4 pt-3">
        <p className="text-xs font-semibold text-muted-foreground">{label}</p>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <p className="text-xl font-bold tabular-nums text-card-foreground">
            {value}
          </p>
          {detail ? (
            <p className="text-xs tabular-nums text-muted-foreground">{detail}</p>
          ) : null}
        </div>
      </div>
      <RtcDebugMetricChart
        history={history}
        value={metric}
        className="mt-2 h-16"
      />
    </section>
  )
}

function QualityBadge({ quality }: { quality: RtcConnectionQuality }) {
  const t = useTranslations('voice')

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold',
        quality === 'good' && 'border-primary/30 bg-primary/10 text-primary',
        quality === 'fair' &&
          'border-chart-4/30 bg-chart-4/10 text-chart-4',
        quality === 'poor' &&
          'border-destructive/30 bg-destructive/10 text-destructive',
        quality === 'unknown' &&
          'border-border bg-muted text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'size-2 rounded-full',
          quality === 'good' && 'bg-primary',
          quality === 'fair' && 'bg-chart-4',
          quality === 'poor' && 'bg-destructive',
          quality === 'unknown' && 'bg-muted-foreground',
        )}
        aria-hidden
      />
      {quality === 'good'
        ? t('debug.goodConnection')
        : quality === 'fair'
          ? t('debug.unstableConnection')
          : quality === 'poor'
            ? t('debug.poorConnection')
            : t('debug.collecting')}
    </div>
  )
}

function MetricGrid({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div>
      <SectionHeader title={title} />
      <div className="grid grid-cols-1 gap-x-8 gap-y-7 xl:grid-cols-2">
        {children}
      </div>
    </div>
  )
}

function MetricGroup({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="min-w-0">
      <h3 className="mb-3 truncate text-sm font-bold text-foreground">{title}</h3>
      <div className="divide-y divide-border">{children}</div>
    </section>
  )
}

function MetricRow({
  label,
  value,
  chart,
}: {
  label: string
  value: ReactNode
  chart?: ReactNode
}) {
  return (
    <section className="min-w-0">
      <div className="flex min-h-10 items-center justify-between gap-4 border-b border-border py-2">
        <div className="min-w-0 text-sm font-bold text-foreground">{label}</div>
        <div className="max-w-55/100 truncate text-right text-sm tabular-nums text-muted-foreground">
          {value}
        </div>
      </div>
      {chart}
    </section>
  )
}

function SectionHeader({ title }: { title: string }) {
  return <h2 className="mb-6 text-base font-bold text-foreground">{title}</h2>
}

function MediaTabs({
  value,
  onChange,
}: {
  value: MediaTab
  onChange: (tab: MediaTab) => void
}) {
  const t = useTranslations('voice')

  return (
    <div className="mb-7 flex gap-6 border-b border-border">
      {(['audio', 'video'] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => onChange(tab)}
          className={cn(
            '-mb-px border-b-2 border-transparent pb-3 text-sm font-semibold text-muted-foreground',
            value === tab && 'border-primary text-primary',
          )}
        >
          {tab === 'audio' ? t('debug.audio') : t('debug.video')}
        </button>
      ))}
    </div>
  )
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-border px-6 py-12">
      <Empty size="inline">
        <EmptyDescription>{text}</EmptyDescription>
      </Empty>
    </div>
  )
}

function DebugEmptyState() {
  const t = useTranslations('voice')

  return (
    <div className="rounded border border-dashed border-border px-6 py-12">
      <Empty size="inline">
        <EmptyHeader>
          <EmptyTitle>{t('debug.noVoiceTitle')}</EmptyTitle>
          <EmptyDescription>{t('debug.noVoiceHint')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  )
}

function formatHybridFrameCount(
  value: number | typeof RTC_DEBUG_BROWSER_UNAVAILABLE,
) {
  return typeof value === 'number' ? String(value) : value
}

function formatFrameSize(width?: number, height?: number) {
  if (width == null || height == null) return '—'
  return `${width}x${height}`
}

function formatRtcMicroseconds(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.round(value)} us`
}
