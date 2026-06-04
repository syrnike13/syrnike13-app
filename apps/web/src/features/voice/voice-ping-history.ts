export type VoicePingSample = {
  timestamp: number
  ms: number
}

/** ~3 минуты при опросе раз в 2 с. */
export const VOICE_PING_HISTORY_MAX = 90

export function appendVoicePingSample(
  history: readonly VoicePingSample[],
  sample: VoicePingSample,
) {
  const next = [...history, sample]
  if (next.length <= VOICE_PING_HISTORY_MAX) return next
  return next.slice(next.length - VOICE_PING_HISTORY_MAX)
}

export function summarizeVoicePingHistory(history: readonly VoicePingSample[]) {
  if (history.length === 0) {
    return { averageMs: null as number | null, lastMs: null as number | null }
  }

  const lastMs = history[history.length - 1]!.ms
  const averageMs = Math.round(
    history.reduce((sum, point) => sum + point.ms, 0) / history.length,
  )

  return { averageMs, lastMs }
}

const CHART_MIN_SPAN_MS = 24
const CHART_PADDING_RATIO = 0.12

export type VoicePingChartDomain = {
  yMin: number
  yMax: number
  yTicks: number[]
}

/** Диапазон оси Y под фактические значения, чтобы мелкие скачки были видны. */
export function voicePingChartDomain(
  history: readonly VoicePingSample[],
): VoicePingChartDomain {
  if (history.length === 0) {
    return { yMin: 0, yMax: 100, yTicks: [0, 50, 100] }
  }

  const values = history.map((point) => point.ms)
  const dataMin = Math.min(...values)
  const dataMax = Math.max(...values)
  const dataSpan = dataMax - dataMin

  let yMin: number
  let yMax: number

  if (dataSpan < CHART_MIN_SPAN_MS) {
    const mid = (dataMin + dataMax) / 2
    yMin = Math.max(0, mid - CHART_MIN_SPAN_MS / 2)
    yMax = mid + CHART_MIN_SPAN_MS / 2
  } else {
    const padding = Math.max(4, Math.ceil(dataSpan * CHART_PADDING_RATIO))
    yMin = Math.max(0, dataMin - padding)
    yMax = dataMax + padding
  }

  const span = Math.max(yMax - yMin, 1)
  const step = niceChartStep(span, 3)
  yMin = Math.floor(yMin / step) * step
  yMax = Math.ceil(yMax / step) * step

  if (yMax <= yMin) {
    yMax = yMin + step
  }

  const yTicks: number[] = []
  for (let tick = yMin; tick <= yMax + step / 2; tick += step) {
    yTicks.push(Math.round(tick))
  }

  return { yMin, yMax, yTicks }
}

function niceChartStep(span: number, targetTickCount: number) {
  const rough = span / Math.max(targetTickCount, 1)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const residual = rough / magnitude

  let nice: number
  if (residual <= 1) nice = 1
  else if (residual <= 2) nice = 2
  else if (residual <= 5) nice = 5
  else nice = 10

  return nice * magnitude
}

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: 'numeric',
  minute: '2-digit',
})

const timeFormatterDetailed = new Intl.DateTimeFormat('ru-RU', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
})

export function formatVoicePingChartTime(timestamp: number) {
  return timeFormatter.format(new Date(timestamp))
}

export function formatVoicePingChartTimeDetailed(timestamp: number) {
  return timeFormatterDetailed.format(new Date(timestamp))
}
