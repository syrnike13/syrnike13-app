import { useEffect, useState, type ReactNode } from 'react'

import { RtcDebugMetricChart } from '#/components/voice/voice-rtc-debug-chart'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { resolveVoiceNodeName } from '#/features/voice/voice-node'
import { useVoice } from '#/features/voice/voice-context'
import {
  RTC_DEBUG_BROWSER_UNAVAILABLE,
  formatRtcBitrate,
  formatRtcBytes,
  formatRtcFps,
  formatRtcInteger,
  formatRtcMs,
  formatRtcValue,
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
  const voice = useVoice()
  const auth = useAuth()
  const { setRtcDebugEnabled } = voice
  const [section, setSection] = useState<DebugSection>('general')
  const [nodeName, setNodeName] = useState<string | null>(null)

  useEffect(() => {
    setRtcDebugEnabled(true)
    return () => setRtcDebugEnabled(false)
  }, [setRtcDebugEnabled])

  useEffect(() => {
    let active = true
    void resolveVoiceNodeName().then((name) => {
      if (active) setNodeName(name)
    })
    return () => {
      active = false
    }
  }, [])

  const snapshot = voice.rtcDebugSnapshot

  return (
    <div className="flex min-h-0 flex-1 bg-[#1e1f24] text-[#f2f3f5]">
      <aside className="w-72 shrink-0 border-r border-[#111214] bg-[#101114] px-8 py-10">
        <div className="mb-6">
          <h1 className="text-xl font-bold leading-none">General</h1>
          <p className="mt-3 text-base text-white">
            {voice.status === 'connected' ? 'Connected' : 'Disconnected'}
          </p>
        </div>

        <p className="mb-2 text-xs font-bold uppercase text-[#949ba4]">
          Отладка RTC: DEFAULT
        </p>
        <nav className="space-y-1">
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={cn(
                'flex h-9 w-full items-center rounded px-3 text-left text-sm font-semibold text-[#b5bac1] transition-colors hover:bg-[#2b2d31] hover:text-white',
                section === item.id && 'bg-[#35363c] text-white',
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto w-full max-w-5xl px-10 py-10">
            {voice.status !== 'connected' ? (
              <DebugEmptyState />
            ) : (
              <DebugSectionBody
                section={section}
                snapshot={snapshot}
                history={voice.rtcDebugHistory}
                nodeName={nodeName}
                localIdentity={auth.user?._id ?? null}
                channelId={voice.channelId}
                participantCount={voice.participantCount}
                stageMediaCount={voice.stageMediaItems.length}
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
      <div className="rounded border border-dashed border-[#3d3f45] px-6 py-12 text-center">
        <h2 className="text-base font-bold">Собираем RTC stats</h2>
        <p className="mt-2 text-sm text-[#949ba4]">
          Первый снимок обычно появляется через секунду после открытия экрана.
        </p>
      </div>
    )
  }

  if (section === 'general') {
    return (
      <MetricGrid title="General">
        <MetricRow label="Connected" value="Yes" />
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
          label="Ping"
          value={formatRtcMs(snapshot.transport.pingMs)}
          chart={<RtcDebugMetricChart history={history} value={(sample) => sample.transport.pingMs} />}
        />
      </MetricGrid>
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
      <MetricRow label="Bytes Sent" value={formatRtcBytes(stream.bytesSent)} />
      <MetricRow label="Bytes Received" value={formatRtcBytes(stream.bytesReceived)} />
      <MetricRow label="Retransmitted Bytes" value={formatRtcBytes(stream.retransmittedBytesSent)} />
      <MetricRow label="NACK" value={formatRtcInteger(stream.nackCount)} />
      <MetricRow label="PLI" value={formatRtcInteger(stream.pliCount)} />
      <MetricRow label="Encode FPS" value={formatRtcFps(stream.framesPerSecond)} />
      <MetricRow label="Frame Size" value={formatFrameSize(stream.frameWidth, stream.frameHeight)} />
      <MetricRow label="Frames Encoded" value={formatRtcInteger(stream.framesEncoded)} />
      <MetricRow label="Frames Decoded" value={formatRtcInteger(stream.framesDecoded)} />
      <MetricRow label="Frames Dropped" value={formatRtcInteger(stream.framesDropped)} />
      <MetricRow label="Freeze Count" value={formatRtcInteger(stream.freezeCount)} />
      <MetricRow label="Freeze Duration" value={formatRtcValue(stream.totalFreezesDuration)} />
      <MetricRow label="Jitter" value={formatRtcValue(stream.jitter)} />
      <MetricRow label="Quality Limitation Reason" value={stream.qualityLimitationReason ?? '—'} />
      <MetricRow label="Audio Level" value={formatRtcValue(stream.audioLevel)} />
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
      <h3 className="mb-3 truncate text-sm font-bold text-white">{title}</h3>
      <div className="divide-y divide-[#292b31]">{children}</div>
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
      <div className="flex min-h-10 items-center justify-between gap-4 border-b border-[#292b31] py-2">
        <div className="min-w-0 text-sm font-bold text-white">{label}</div>
        <div className="max-w-[55%] truncate text-right text-sm tabular-nums text-[#aeb4bd]">
          {value}
        </div>
      </div>
      {chart}
    </section>
  )
}

function SectionHeader({ title }: { title: string }) {
  return <h2 className="mb-6 text-base font-bold text-white">{title}</h2>
}

function MediaTabs({
  value,
  onChange,
}: {
  value: MediaTab
  onChange: (tab: MediaTab) => void
}) {
  return (
    <div className="mb-7 flex gap-6 border-b border-[#292b31]">
      {(['audio', 'video'] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => onChange(tab)}
          className={cn(
            '-mb-px border-b-2 border-transparent pb-3 text-sm font-semibold text-[#b5bac1]',
            value === tab && 'border-[#5865f2] text-[#7289ff]',
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
    <div className="rounded border border-dashed border-[#3d3f45] px-6 py-12 text-center text-sm text-[#949ba4]">
      {text}
    </div>
  )
}

function DebugEmptyState() {
  return (
    <div className="rounded border border-dashed border-[#3d3f45] px-6 py-12 text-center">
      <h2 className="text-base font-bold">Нет активного голосового подключения</h2>
      <p className="mt-2 text-sm text-[#949ba4]">
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
