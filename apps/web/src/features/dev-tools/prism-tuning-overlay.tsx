// design-allow-file hardcoded-string: internal developer Prism tuning overlay.
import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_PRISM_TUNING,
  applyThemeToDocument,
  readSystemPrefersDark,
  type PrismSurfaceMixKey,
  type PrismTuning,
} from '@syrnike13/ui/tokens'

import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  RotateCcwIcon,
  Settings2Icon,
  XIcon,
} from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import { Label } from '@syrnike13/ui/primitives/label'
import { Separator } from '@syrnike13/ui/primitives/separator'
import { Slider } from '@syrnike13/ui/primitives/slider'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import { useAppearance } from '#/features/appearance/appearance-context'

const STORAGE_KEY = 'syrnike13-prism-tuning:v2'

const SURFACE_KEYS: readonly PrismSurfaceMixKey[] = [
  'card',
  'popover',
  'secondary',
  'muted',
  'input',
  'sidebar',
  'border',
  'accent',
  'hover',
  'selection',
]

const SURFACE_LABELS: Record<PrismSurfaceMixKey, string> = {
  card: 'Card',
  popover: 'Popover',
  secondary: 'Secondary',
  muted: 'Muted',
  input: 'Input surface',
  sidebar: 'Sidebar',
  border: 'Border / divider',
  accent: 'Accent fill',
  hover: 'Hover fill',
  selection: 'Selection',
}

function cloneDefaults(): PrismTuning {
  return {
    surfaceMix: { ...DEFAULT_PRISM_TUNING.surfaceMix },
    raisedMix: { ...DEFAULT_PRISM_TUNING.raisedMix },
    minInteractionDelta: { ...DEFAULT_PRISM_TUNING.minInteractionDelta },
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function sanitizeTuning(value: unknown): PrismTuning {
  const base = cloneDefaults()
  if (!value || typeof value !== 'object') return base
  const record = value as Record<string, unknown>

  const surfaceMix = record.surfaceMix
  if (surfaceMix && typeof surfaceMix === 'object') {
    for (const key of SURFACE_KEYS) {
      const value = (surfaceMix as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        base.surfaceMix[key] = clamp(value, 0, 60)
      }
    }
  }

  const raisedMix = record.raisedMix
  if (raisedMix && typeof raisedMix === 'object') {
    for (const mode of ['light', 'dark'] as const) {
      const value = (raisedMix as Record<string, unknown>)[mode]
      if (typeof value === 'number' && Number.isFinite(value)) {
        base.raisedMix[mode] = clamp(value, 0, 60)
      }
    }
  }

  const deltas = record.minInteractionDelta
  if (deltas && typeof deltas === 'object') {
    for (const key of ['accent', 'hover'] as const) {
      const value = (deltas as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        base.minInteractionDelta[key] = clamp(value, 0, 0.3)
      }
    }
  }

  return base
}

function readStoredTuning(): PrismTuning {
  if (typeof window === 'undefined') return cloneDefaults()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? sanitizeTuning(JSON.parse(raw)) : cloneDefaults()
  } catch {
    return cloneDefaults()
  }
}

function TuningSlider({
  label,
  value,
  min = 0,
  max = 40,
  step = 1,
  suffix = '%',
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-normal text-muted-foreground">
          {label}
        </Label>
        <span className="w-12 shrink-0 text-right text-xs tabular-nums">
          {value}
          {suffix}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        onValueChange={(next) => {
          const resolved = typeof next === 'number' ? next : next[0]
          if (resolved != null) onChange(resolved)
        }}
      />
    </div>
  )
}

export function PrismTuningOverlay() {
  const { settings } = useAppearance()
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [showJson, setShowJson] = useState(false)
  const [copied, setCopied] = useState(false)
  const [tuning, setTuning] = useState<PrismTuning>(readStoredTuning)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning))
    } catch {
      // private mode
    }
  }, [tuning])

  // Tuning stays active while the panel is closed so it can be compared in the
  // real screens; Reset (not Close) returns the app to Prism defaults.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      applyThemeToDocument(settings, readSystemPrefersDark(), tuning)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [settings, tuning])

  const json = useMemo(
    () =>
      JSON.stringify(
        {
          version: 1,
          themeId: settings.themeId,
          colorMode: settings.colorMode,
          surfaceMix: tuning.surfaceMix,
          raisedMix: tuning.raisedMix,
          minInteractionDelta: tuning.minInteractionDelta,
        },
        null,
        2,
      ),
    [settings.colorMode, settings.themeId, tuning],
  )

  function close() {
    setOpen(false)
  }

  function reset() {
    setTuning(cloneDefaults())
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setShowJson(true)
    }
  }

  function downloadJson() {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'prism-tuning.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  const isCustom = useMemo(
    () => JSON.stringify(tuning) !== JSON.stringify(DEFAULT_PRISM_TUNING),
    [tuning],
  )

  // localStorage is client-only: keep the first render identical to SSR.
  if (!mounted) return null

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant={isCustom ? 'secondary' : 'outline'}
        className="fixed right-4 bottom-4 z-1000 gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Settings2Icon className="size-4" />
        Prism tuning{isCustom ? ' · custom' : ''}
      </Button>
    )
  }

  return (
    <div className="fixed right-4 bottom-4 z-1000 w-88 max-w-viewport-inset">
      <Card className="max-h-prism-tuning-body overflow-hidden shadow-xl">
        <CardHeader className="flex-row items-center gap-2 border-b">
          <CardTitle className="flex-1 text-sm">Prism tuning</CardTitle>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close tuning"
            onClick={close}
          >
            <XIcon className="size-4" />
          </Button>
        </CardHeader>
        <CardContent className="max-h-prism-tuning space-y-3 overflow-y-auto pt-4">
          <p className="text-xs text-muted-foreground">
            Live mix percentages for {settings.themeId} · {settings.colorMode}.
            Changes apply immediately and stay active after closing the panel;
            use Reset to return to Prism defaults. The percentages are global,
            while themes differ by anchors and contrast.
          </p>

          {SURFACE_KEYS.map((key) => (
            <TuningSlider
              key={key}
              label={SURFACE_LABELS[key]}
              value={tuning.surfaceMix[key]}
              onChange={(value) =>
                setTuning((current) => ({
                  ...current,
                  surfaceMix: { ...current.surfaceMix, [key]: value },
                }))
              }
            />
          ))}

          <Separator />
          <TuningSlider
            label="Raised · light"
            value={tuning.raisedMix.light}
            onChange={(value) =>
              setTuning((current) => ({
                ...current,
                raisedMix: { ...current.raisedMix, light: value },
              }))
            }
          />
          <TuningSlider
            label="Raised · dark"
            value={tuning.raisedMix.dark}
            onChange={(value) =>
              setTuning((current) => ({
                ...current,
                raisedMix: { ...current.raisedMix, dark: value },
              }))
            }
          />

          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full justify-start"
            onClick={() => setAdvanced((value) => !value)}
          >
            {advanced ? 'Hide advanced' : 'Show advanced'}
          </Button>

          {advanced ? (
            <>
              <TuningSlider
                label="Min accent Δ"
                value={tuning.minInteractionDelta.accent}
                min={0}
                max={0.2}
                step={0.005}
                suffix=""
                onChange={(value) =>
                  setTuning((current) => ({
                    ...current,
                    minInteractionDelta: {
                      ...current.minInteractionDelta,
                      accent: value,
                    },
                  }))
                }
              />
              <TuningSlider
                label="Min hover Δ"
                value={tuning.minInteractionDelta.hover}
                min={0}
                max={0.2}
                step={0.005}
                suffix=""
                onChange={(value) =>
                  setTuning((current) => ({
                    ...current,
                    minInteractionDelta: {
                      ...current.minInteractionDelta,
                      hover: value,
                    },
                  }))
                }
              />
            </>
          ) : null}

          <Separator />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={reset}>
              <RotateCcwIcon className="size-4" />
              Reset
            </Button>
            <Button
              type="button"
              size="sm"
              variant={showJson ? 'secondary' : 'outline'}
              onClick={() => setShowJson((value) => !value)}
            >
              <DownloadIcon className="size-4" />
              {showJson ? 'Hide JSON' : 'Export JSON'}
            </Button>
            {showJson ? (
              <>
                <Button type="button" size="sm" onClick={downloadJson}>
                  <DownloadIcon className="size-4" />
                  Download
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void copyJson()}
                >
                  {copied ? (
                    <CheckIcon className="size-4" />
                  ) : (
                    <CopyIcon className="size-4" />
                  )}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </>
            ) : null}
          </div>

          {showJson ? (
            <Textarea
              readOnly
              value={json}
              aria-label="Prism tuning JSON"
              className="h-48 resize-none font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
