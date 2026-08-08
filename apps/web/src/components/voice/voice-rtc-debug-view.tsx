import { useEffect, useState, type ReactNode } from 'react'
import { Effect, Fiber } from 'effect'

import { RtcDebugMetricChart } from '#/components/voice/voice-rtc-debug-chart'
import { ScrollArea } from '#/components/ui/scroll-area'
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

const sections: Array<{ id: DebugSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'transport', label: 'Передача данных' },
  { id: 'outgoing', label: 'Исходящие' },
  { id: 'incoming', label: 'Входящие' },
  { id: 'screen', label: 'Демонстрация экрана' },
]

export function VoiceRtcDebugView() {
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
    <div className="gradient-surface-content flex min-h-0 flex-1 flex-col bg-background text-foreground lg:flex-row">
      <aside className="gradient-surface-navigation shrink-0 border-b border-border bg-sidebar px-4 py-4 text-sidebar-foreground lg:w-60 lg:border-r lg:border-b-0 lg:px-5 lg:py-8">
        <div className="mb-4 lg:mb-6">
          <h1 className="text-lg font-bold leading-none">RTC диагностика</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {voiceSession.status === 'connected' ? 'Подключено' : 'Отключено'}
          </p>
        </div>

        <p className="mb-2 hidden text-xs font-bold uppercase text-muted-foreground lg:block">
          Разделы
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
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
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
      </main>
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
  if (!snapshot) {
    return (
      <div className="rounded border border-dashed border-border px-6 py-12 text-center">
        <h2 className="text-base font-bold">Собираем RTC stats</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Первый снимок обычно появляется через секунду после открытия экрана.
        </p>
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
        title="Исходящие"
        streams={snapshot.outbound}
        history={history}
        direction="outbound"
      />
    )
  }

  if (section === 'incoming') {
    return (
      <RtpSection
        title="Входящие"
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
  const quality = rtcConnectionQuality(snapshot)
  const rates = snapshot.rates

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-foreground">Состояние соединения</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {snapshot.source === 'windows_native'
              ? 'Windows native LiveKit runtime'
              : 'Browser WebRTC getStats()'}
          </p>
        </div>
        <QualityBadge quality={quality} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <OverviewCard
          label="Пинг"
          value={formatRtcMs(snapshot.transport.pingMs)}
          history={history}
          metric={(sample) => sample.transport.pingMs}
        />
        <OverviewCard
          label="Потери пакетов"
          value={formatRtcPercent(rates?.quality.packetLossPercent)}
          history={history}
          metric={(sample) => sample.rates?.quality.packetLossPercent}
        />
        <OverviewCard
          label="Джиттер"
          value={formatRtcMs(rates?.quality.jitterMs)}
          history={history}
          metric={(sample) => sample.rates?.quality.jitterMs}
        />
        <OverviewCard
          label="Дроп кадров"
          value={formatRtcPercent(rates?.quality.framesDroppedPercent)}
          detail={
            rates?.quality.framesDroppedPerSecond == null
              ? undefined
              : `${rates.quality.framesDroppedPerSecond.toFixed(1)} кадр/с`
          }
          history={history}
          metric={(sample) => sample.rates?.quality.framesDroppedPercent}
        />
        <OverviewCard
          label="Входящий поток"
          value={formatRtcBitrate(rates?.transport.inboundBitrate)}
          history={history}
          metric={(sample) => sample.rates?.transport.inboundBitrate}
        />
        <OverviewCard
          label="Исходящий поток"
          value={formatRtcBitrate(rates?.transport.outboundBitrate)}
          history={history}
          metric={(sample) => sample.rates?.transport.outboundBitrate}
        />
      </div>

      <div className="mt-8">
        <MetricGrid title="Сессия">
          <MetricRow label="Voice Node" value={nodeName ?? '—'} />
          <MetricRow label="Channel" value={channelId ?? '—'} />
          <MetricRow label="Local Identity" value={localIdentity ?? '—'} />
          <MetricRow label="Participant Count" value={participantCount} />
          <MetricRow label="Stage Media Items" value={stageMediaCount} />
          <MetricRow
            label="Selected ICE Candidate"
            value={snapshot.transport.selectedCandidatePairId ?? '—'}
          />
          <MetricRow
            label="Скрытые аудиосэмплы"
            value={formatRtcPercent(rates?.quality.concealedAudioPercent)}
          />
          <MetricRow
            label="Источник статистики"
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
  return (
    <MetricGrid title="Передача данных">
      <MetricRow
        label="Available Outgoing Bitrate"
        value={formatRtcBitrate(snapshot.transport.availableOutgoingBitrate)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.availableOutgoingBitrate} />}
      />
      <MetricRow
        label="Available Incoming Bitrate"
        value={formatRtcBitrate(snapshot.transport.availableIncomingBitrate)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.availableIncomingBitrate} />}
      />
      <MetricRow
        label="Ping"
        value={formatRtcMs(snapshot.transport.pingMs)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.pingMs} />}
      />
      <MetricRow label="Local Address" value={snapshot.transport.localAddress ?? '—'} />
      <MetricRow label="Remote Address" value={snapshot.transport.remoteAddress ?? '—'} />
      <MetricRow label="Pacer Delay" value="N/A" />
      <MetricRow
        label="Outbound Bitrate Estimate"
        value={formatRtcBitrate(snapshot.rates?.transport.outboundBitrate)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.rates?.transport.outboundBitrate} />}
      />
      <MetricRow
        label="Inbound Bitrate Estimate"
        value={formatRtcBitrate(snapshot.rates?.transport.inboundBitrate)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.rates?.transport.inboundBitrate} />}
      />
      <MetricRow
        label="Packets Received"
        value={formatRtcInteger(snapshot.transport.packetsReceived)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.packetsReceived} />}
      />
      <MetricRow
        label="Packets Sent"
        value={formatRtcInteger(snapshot.transport.packetsSent)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.packetsSent} />}
      />
      <MetricRow
        label="Bytes Received"
        value={formatRtcBytes(snapshot.transport.bytesReceived)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.bytesReceived} />}
      />
      <MetricRow
        label="Bytes Sent"
        value={formatRtcBytes(snapshot.transport.bytesSent)}
        chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.bytesSent} />}
      />
      <MetricRow label="Hostname" value={nodeName ?? '—'} />
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
  const [tab, setTab] = useState<MediaTab>('audio')
  const filtered = streams.filter((stream) => stream.kind === tab)

  return (
    <div>
      <SectionHeader title={title} />
      <MediaTabs value={tab} onChange={setTab} />
      {filtered.length === 0 ? (
        <EmptyPanel text={`Нет ${tab === 'audio' ? 'audio' : 'video'} RTP streams.`} />
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
      <MetricRow label="Codec" value={stream.codec ?? '—'} />
      <MetricRow
        label="Bitrate"
        value={formatRtcBitrate(currentRate)}
        chart={<RtcDebugMetricChart history={history} value={rate} />}
      />
      <MetricRow label="Bitrate (Target)" value={formatRtcBitrate(stream.targetBitrate)} />
      <MetricRow label="Packets Sent" value={formatRtcInteger(stream.packetsSent)} />
      <MetricRow label="Packets Received" value={formatRtcInteger(stream.packetsReceived)} />
      <MetricRow label="Packets Lost" value={formatRtcInteger(stream.packetsLost)} />
      <MetricRow
        label="Packet Loss"
        value={formatRtcPercent(stream.packetLossPercent)}
      />
      <MetricRow
        label="Round Trip Time"
        value={formatRtcMs(stream.roundTripTimeMs)}
      />
      <MetricRow label="Bytes Sent" value={formatRtcBytes(stream.bytesSent)} />
      <MetricRow label="Bytes Received" value={formatRtcBytes(stream.bytesReceived)} />
      <MetricRow
        label="Retransmitted Packets"
        value={formatRtcInteger(
          stream.retransmittedPacketsSent ??
            stream.retransmittedPacketsReceived,
        )}
      />
      <MetricRow
        label="Retransmitted Bytes"
        value={formatRtcBytes(
          stream.retransmittedBytesSent ?? stream.retransmittedBytesReceived,
        )}
      />
      <MetricRow
        label="Discarded Packets"
        value={formatRtcInteger(stream.packetsDiscarded)}
      />
      <MetricRow label="NACK" value={formatRtcInteger(stream.nackCount)} />
      <MetricRow label="FIR" value={formatRtcInteger(stream.firCount)} />
      <MetricRow label="PLI" value={formatRtcInteger(stream.pliCount)} />
      <MetricRow label="Encode FPS" value={formatRtcFps(stream.framesPerSecond)} />
      <MetricRow label="Frame Size" value={formatFrameSize(stream.frameWidth, stream.frameHeight)} />
      <MetricRow label="Frames Sent" value={formatRtcInteger(stream.framesSent)} />
      <MetricRow label="Frames Received" value={formatRtcInteger(stream.framesReceived)} />
      <MetricRow label="Frames Rendered" value={formatRtcInteger(stream.framesRendered)} />
      <MetricRow label="Frames Encoded" value={formatRtcInteger(stream.framesEncoded)} />
      <MetricRow label="Frames Decoded" value={formatRtcInteger(stream.framesDecoded)} />
      <MetricRow label="Frames Dropped" value={formatRtcInteger(stream.framesDropped)} />
      <MetricRow label="Freeze Count" value={formatRtcInteger(stream.freezeCount)} />
      <MetricRow label="Freeze Duration" value={formatRtcValue(stream.totalFreezesDuration)} />
      <MetricRow
        label="Jitter"
        value={formatRtcMs(
          stream.jitter == null ? undefined : stream.jitter * 1000,
        )}
      />
      <MetricRow label="Quality Limitation Reason" value={stream.qualityLimitationReason ?? '—'} />
      <MetricRow
        label="Encoder"
        value={stream.encoderImplementation ?? '—'}
      />
      <MetricRow
        label="Decoder"
        value={stream.decoderImplementation ?? '—'}
      />
      <MetricRow label="Audio Level" value={formatRtcValue(stream.audioLevel)} />
      <MetricRow label="Total Audio Energy" value={formatRtcValue(stream.totalAudioEnergy)} />
      <MetricRow label="Samples Duration" value={formatRtcValue(stream.totalSamplesDuration)} />
      <MetricRow label="Samples Received" value={formatRtcInteger(stream.totalSamplesReceived)} />
      <MetricRow label="Concealed Samples" value={formatRtcInteger(stream.concealedSamples)} />
      <MetricRow label="Silent Concealed Samples" value={formatRtcInteger(stream.silentConcealedSamples)} />
      <MetricRow label="Concealment Events" value={formatRtcInteger(stream.concealmentEvents)} />
      <MetricRow label="Jitter Buffer Delay" value={formatRtcValue(stream.jitterBufferDelay)} />
      <MetricRow label="Jitter Buffer Target" value={formatRtcValue(stream.jitterBufferTargetDelay)} />
      <MetricRow label="Jitter Buffer Emitted" value={formatRtcInteger(stream.jitterBufferEmittedCount)} />
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
  const screenShares = snapshot.screenShares

  return (
    <div>
      <SectionHeader title="Демонстрация экрана" />
      {screenShares.length === 0 ? (
        <EmptyPanel text="Активных screen share плиток нет." />
      ) : (
        <div className="grid grid-cols-1 gap-x-8 gap-y-7 xl:grid-cols-2">
          {screenShares.map((share) => (
            <MetricGroup
              key={share.id}
              title={`${share.isLocal ? 'Local' : 'Remote'} / ${share.ownerUserId}`}
            >
              <MetricRow label="Publication ID" value={share.publicationId ?? '—'} />
              <MetricRow label="Owner" value={share.ownerUserId} />
              <MetricRow label="Subscribed" value={formatRtcValue(share.subscribed)} />
              <MetricRow label="Live" value={formatRtcValue(share.live)} />
              <MetricRow label="Capture Width" value={formatRtcInteger(share.captureWidth)} />
              <MetricRow label="Capture Height" value={formatRtcInteger(share.captureHeight)} />
              <MetricRow label="Capture FPS" value={formatRtcFps(share.captureFrameRate)} />
              <MetricRow label="Display Surface" value={share.displaySurface ?? '—'} />
              <MetricRow label="Cursor" value={share.cursor ?? '—'} />
              <MetricRow label="Logical Surface" value={formatRtcValue(share.logicalSurface)} />
              <MetricRow label="Resize Mode" value={share.resizeMode ?? '—'} />
              <MetricRow label="Content Hint" value={share.contentHint ?? '—'} />
              <MetricRow label="Codec" value={share.codec ?? '—'} />
              <MetricRow label="Max Bitrate" value={formatRtcBitrate(share.maxBitrate)} />
              <MetricRow label="Max Framerate" value={formatRtcFps(share.maxFramerate)} />
              <MetricRow label="Simulcast" value={formatRtcValue(share.simulcast)} />
              <MetricRow label="Degradation Preference" value={share.degradationPreference ?? '—'} />
              <MetricRow label="Capture Backend" value={share.captureBackend ?? '—'} />
              <MetricRow label="Capture Method" value={share.captureMethod ?? '—'} />
              <MetricRow
                label="Capture Video Published"
                value={formatRtcValue(share.captureVideoPublished)}
              />
              <MetricRow
                label="Capture Video Frames"
                value={formatRtcInteger(share.captureVideoFrames)}
              />
              <MetricRow
                label="Capture Interval Frames"
                value={formatRtcInteger(share.captureVideoIntervalFrames)}
              />
              <MetricRow
                label="Capture Late Frames"
                value={formatRtcInteger(share.captureVideoLateFrames)}
              />
              <MetricRow
                label="Capture No Frames"
                value={formatRtcInteger(share.captureVideoNoFrameCount)}
              />
              <MetricRow
                label="Capture Repeated Frames"
                value={formatRtcInteger(share.captureVideoRepeatedFrameCount)}
              />
              <MetricRow
                label="Capture Recoverable Lost"
                value={formatRtcInteger(share.captureVideoRecoverableLostCount)}
              />
              <MetricRow
                label="Avg Capture"
                value={formatRtcMicroseconds(share.captureVideoAvgCaptureUs)}
              />
              <MetricRow
                label="Avg Readback"
                value={formatRtcMicroseconds(share.captureVideoAvgReadbackUs)}
              />
              <MetricRow
                label="Avg Scale"
                value={formatRtcMicroseconds(share.captureVideoAvgScaleUs)}
              />
              <MetricRow
                label="Avg Publish"
                value={formatRtcMicroseconds(share.captureVideoAvgPublishUs)}
              />
              <MetricRow
                label="Capture Source Size"
                value={formatFrameSize(share.captureVideoSourceWidth, share.captureVideoSourceHeight)}
              />
              <MetricRow
                label="Capture Content Size"
                value={formatFrameSize(share.captureVideoContentWidth, share.captureVideoContentHeight)}
              />
              <MetricRow
                label="Capture Thread MMCSS"
                value={formatRtcValue(share.captureThreadMmcss)}
              />
              <MetricRow
                label="Hybrid DXGI Frames"
                value={formatHybridFrameCount(share.hybridDxgiFrames)}
              />
              <MetricRow
                label="Hybrid GDI BitBlt Frames"
                value={formatHybridFrameCount(share.hybridGdiBitBltFrames)}
              />
              <MetricRow
                label="Hybrid GDI PrintWindow Frames"
                value={formatHybridFrameCount(share.hybridGdiPrintWindowFrames)}
              />
              <MetricRow
                label="Hybrid Graphics Capture Frames"
                value={formatHybridFrameCount(share.hybridGraphicsCaptureFrames)}
              />
              <MetricRow label="Hybrid Videohook Frames" value={RTC_DEBUG_BROWSER_UNAVAILABLE} />
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
  const sentHistoryValue = (sample: RtcDebugSnapshot) =>
    sample.screenShares.find((share) => share.id === shareId)?.sentBitrate
  const receivedHistoryValue = (sample: RtcDebugSnapshot) =>
    sample.screenShares.find((share) => share.id === shareId)?.receivedBitrate

  return (
    <>
      {sentBitrate != null ? (
        <MetricRow
          label="Live Sent Bitrate"
          value={formatRtcBitrate(sentBitrate)}
          chart={<RtcDebugMetricChart history={history} value={sentHistoryValue} />}
        />
      ) : null}
      {receivedBitrate != null ? (
        <MetricRow
          label="Live Received Bitrate"
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
        ? 'Хорошее соединение'
        : quality === 'fair'
          ? 'Нестабильное соединение'
          : quality === 'poor'
            ? 'Плохое соединение'
            : 'Собираем данные'}
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
        <div className="max-w-[55%] truncate text-right text-sm tabular-nums text-muted-foreground">
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
          {tab === 'audio' ? 'Audio' : 'Video'}
        </button>
      ))}
    </div>
  )
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}

function DebugEmptyState() {
  return (
    <div className="rounded border border-dashed border-border px-6 py-12 text-center">
      <h2 className="text-base font-bold">Нет активного голосового подключения</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Подключись к voice channel, затем открой эту страницу ещё раз из ping UI.
      </p>
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
