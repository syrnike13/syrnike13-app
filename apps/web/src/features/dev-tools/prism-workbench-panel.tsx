// design-allow-file hardcoded-string: internal developer theme workbench.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from 'react'

import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CopyIcon,
  DownloadIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@syrnike13/ui/primitives/collapsible'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import { Separator } from '@syrnike13/ui/primitives/separator'
import { Slider } from '@syrnike13/ui/primitives/slider'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import {
  getThemeTokens,
  type PrismTuning,
  type ThemeVariant,
} from '@syrnike13/ui/tokens'

import { useAppearance } from '#/features/appearance/appearance-context'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
import {
  ANCHOR_KEYS,
  SURFACE_KEYS,
  SURFACE_LABELS,
  normalizeColorHex,
  suggestThemeId,
  themeIsModified,
  type AddThemeResult,
  type PrismAnchorColorKey,
  type ThemeAnchors,
  type ThemeWorkbenchEntry,
} from './use-prism-workbench'

const ANCHOR_LABELS: Record<PrismAnchorColorKey, string> = {
  accent: 'Accent',
  background: 'Background',
  foreground: 'Foreground',
}

const VARIANT_LABELS: Record<ThemeVariant, string> = {
  light: 'Light',
  dark: 'Dark',
}

const PREVIEW_OPTIONS: readonly {
  value: ThemeVariant | null
  label: string
}[] = [
  { value: null, label: 'App' },
  { value: 'light', label: VARIANT_LABELS.light },
  { value: 'dark', label: VARIANT_LABELS.dark },
]

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

function ColorField({
  id,
  label,
  accessibleName,
  value,
  onChange,
}: {
  id: string
  label: string
  accessibleName: string
  value: string
  onChange: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  function update(next: string) {
    setDraft(next)
    const normalized = normalizeColorHex(next)
    if (normalized) onChange(normalized)
  }

  return (
    <div className="flex items-center gap-2">
      <Label
        htmlFor={id}
        className="flex-1 text-xs font-normal text-muted-foreground"
      >
        {label}
      </Label>
      <label
        className="relative size-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-input bg-(--swatch-color)"
        style={{ '--swatch-color': value } as CSSVars}
      >
        <input
          type="color"
          aria-label={`${accessibleName} picker`}
          value={value}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <Input
        id={id}
        aria-label={accessibleName}
        className="h-7 w-24 font-mono text-xs"
        value={draft}
        onChange={(event) => update(event.target.value)}
        onBlur={() => setDraft(value)}
      />
    </div>
  )
}

/** Mini palette of derived roles, so surfaces can be judged per variant. */
function AnchorPreview({
  themeId,
  variant,
  anchors,
  tuning,
}: {
  themeId: string
  variant: ThemeVariant
  anchors: ThemeAnchors
  tuning: PrismTuning
}) {
  const tokens = getThemeTokens(
    { themeId, colorMode: variant },
    variant === 'dark',
    tuning,
    anchors,
  )
  const swatches = [
    ['background', tokens.background],
    ['card', tokens.card],
    ['muted', tokens.muted],
    ['accent', tokens.accent],
    ['border', tokens.border],
    ['foreground', tokens.foreground],
  ] as const

  return (
    <div className="flex h-5 overflow-hidden rounded-sm border">
      {swatches.map(([name, color]) => (
        <span
          key={name}
          title={name}
          aria-hidden="true"
          className="flex-1 bg-(--swatch-color)"
          style={{ '--swatch-color': color } as CSSVars}
        />
      ))}
    </div>
  )
}

function AnchorEditor({
  themeId,
  variant,
  anchors,
  tuning,
  onColorChange,
  onContrastChange,
}: {
  themeId: string
  variant: ThemeVariant
  anchors: ThemeAnchors
  tuning: PrismTuning
  onColorChange: (key: PrismAnchorColorKey, value: string) => void
  onContrastChange: (value: number) => void
}) {
  const variantLabel = VARIANT_LABELS[variant]
  const variantAnchors = anchors[variant]

  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <AnchorPreview
        themeId={themeId}
        variant={variant}
        anchors={anchors}
        tuning={tuning}
      />
      {ANCHOR_KEYS.map((key) => (
        <ColorField
          key={key}
          id={`prism-${variant}-${key}`}
          label={ANCHOR_LABELS[key]}
          accessibleName={`${variantLabel} ${ANCHOR_LABELS[key].toLowerCase()}`}
          value={variantAnchors[key]}
          onChange={(value) => onColorChange(key, value)}
        />
      ))}
      <TuningSlider
        label={`${variantLabel} contrast`}
        value={variantAnchors.contrast}
        min={0}
        max={100}
        suffix=""
        onChange={onContrastChange}
      />
    </div>
  )
}

function WorkbenchSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)

  return (
    <section className="rounded-lg border">
      <Collapsible open={open} onOpenChange={(next) => setOpen(next)}>
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
          <span>{title}</span>
          <ChevronDownIcon
            className={cn(
              'size-3.5 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t px-2.5 py-2.5">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}

export function PrismWorkbenchPanel({
  themes,
  selectedTheme,
  tuning,
  previewVariant,
  activeVariant,
  onSelectTheme,
  onAddTheme,
  onRemoveTheme,
  onRestoreTheme,
  onTuningChange,
  onAnchorColorChange,
  onAnchorContrastChange,
  onPreviewVariantChange,
  onResetAll,
}: {
  themes: readonly ThemeWorkbenchEntry[]
  selectedTheme: ThemeWorkbenchEntry
  tuning: PrismTuning
  previewVariant: ThemeVariant | null
  activeVariant: ThemeVariant
  onSelectTheme: (themeId: string) => void
  onAddTheme: (themeId: string) => AddThemeResult
  onRemoveTheme: () => void
  onRestoreTheme: () => void
  onTuningChange: Dispatch<SetStateAction<PrismTuning>>
  onAnchorColorChange: (
    variant: ThemeVariant,
    key: PrismAnchorColorKey,
    value: string,
  ) => void
  onAnchorContrastChange: (variant: ThemeVariant, value: number) => void
  onPreviewVariantChange: (variant: ThemeVariant | null) => void
  onResetAll: () => void
}) {
  const { settings } = useAppearance()
  const [creatingTheme, setCreatingTheme] = useState(false)
  const [newThemeId, setNewThemeId] = useState('')
  const [newThemeError, setNewThemeError] = useState<string | null>(null)
  const [showingExport, setShowingExport] = useState(false)
  const [copied, setCopied] = useState(false)
  const jsonRef = useRef<HTMLTextAreaElement>(null)

  const selectedModified = themeIsModified(selectedTheme)
  const json = useMemo(
    () =>
      JSON.stringify(
        {
          version: 3,
          themes: themes.map(({ id, origin, anchors }) => ({
            id,
            origin,
            anchors,
          })),
          tuning,
        },
        null,
        2,
      ),
    [themes, tuning],
  )

  function openNewTheme() {
    setNewThemeId(suggestThemeId(themes))
    setNewThemeError(null)
    setCreatingTheme(true)
  }

  function createTheme(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = onAddTheme(newThemeId)
    if (result === 'added') {
      setCreatingTheme(false)
      return
    }
    setNewThemeError(
      result === 'duplicate'
        ? 'Theme id already exists.'
        : 'Use lowercase letters, digits and hyphens.',
    )
  }

  function removeTheme() {
    if (!window.confirm(`Delete theme "${selectedTheme.id}"?`)) return
    onRemoveTheme()
  }

  function resetAll() {
    if (!window.confirm('Reset all theme edits and Prism tuning?')) return
    onResetAll()
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      jsonRef.current?.focus()
      jsonRef.current?.select()
    }
  }

  function downloadJson() {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'prism-themes.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  if (showingExport) {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pt-1 pb-3">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Back to themes"
              title="Back to themes"
              onClick={() => setShowingExport(false)}
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
            <span className="text-xs font-medium">
              JSON · {themes.length} themes
            </span>
          </div>
          <Textarea
            ref={jsonRef}
            readOnly
            value={json}
            aria-label="Prism themes JSON"
            className="h-72 min-h-40 resize-none font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="text-xs text-muted-foreground">
            Themes become THEME_CATALOG entries; tuning becomes
            DEFAULT_PRISM_TUNING.
          </p>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-4 py-2.5">
          <Button type="button" size="sm" variant="outline" onClick={downloadJson}>
            <DownloadIcon className="size-4" />
            Download
          </Button>
          <Button type="button" size="sm" onClick={() => void copyJson()}>
            {copied ? (
              <CheckIcon className="size-4" />
            ) : (
              <CopyIcon className="size-4" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pt-1 pb-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">Themes</span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={openNewTheme}
          >
            <PlusIcon className="size-3.5" />
            New theme
          </Button>
        </div>

        <div className="max-h-48 space-y-1 overflow-y-auto pr-0.5">
          {themes.map((theme) => {
            const selected = theme.id === selectedTheme.id
            return (
              <div
                key={theme.id}
                className={cn(
                  'flex items-center gap-1 rounded-lg border pr-1 pl-0.5',
                  selected && 'border-ring/40 bg-secondary',
                )}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() => onSelectTheme(theme.id)}
                >
                  <span className="truncate font-mono">{theme.id}</span>
                  {themeIsModified(theme) ? (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-primary"
                      aria-hidden="true"
                    />
                  ) : null}
                  {theme.origin === 'added' ? (
                    <span
                      className="shrink-0 text-xs text-muted-foreground"
                      aria-hidden="true"
                    >
                      new
                    </span>
                  ) : null}
                </button>
                {selected ? (
                  theme.origin === 'added' ? (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Delete theme"
                      title="Delete theme"
                      onClick={removeTheme}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Restore catalog colors"
                      title="Restore catalog colors"
                      disabled={!selectedModified}
                      onClick={onRestoreTheme}
                    >
                      <RotateCcwIcon className="size-3.5" />
                    </Button>
                  )
                ) : null}
              </div>
            )
          })}
        </div>

        <p className="text-xs text-muted-foreground">
          Preview reverts to the saved theme ({settings.themeId}) when you leave
          this tab.
        </p>

        {creatingTheme ? (
          <form
            className="space-y-1.5 rounded-lg border p-2.5"
            onSubmit={createTheme}
          >
            <Label htmlFor="prism-new-theme-id" className="text-xs">
              New theme id
            </Label>
            <div className="flex items-center gap-1">
              <Input
                id="prism-new-theme-id"
                autoFocus
                className="h-7 min-w-0 flex-1 font-mono text-xs"
                value={newThemeId}
                aria-invalid={newThemeError ? true : undefined}
                onChange={(event) => {
                  setNewThemeId(event.target.value)
                  setNewThemeError(null)
                }}
              />
              <Button type="submit" size="sm">
                Create
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setCreatingTheme(false)}
              >
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Starts from {selectedTheme.id} colors. Lowercase letters, digits
              and hyphens.
            </p>
            {newThemeError ? (
              <p className="text-xs text-destructive">{newThemeError}</p>
            ) : null}
          </form>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">
            Colors · {VARIANT_LABELS[activeVariant]}
          </span>
          <div className="flex gap-1" role="group" aria-label="Preview mode">
            {PREVIEW_OPTIONS.map((option) => {
              const selected = previewVariant === option.value
              return (
                <Button
                  key={option.label}
                  type="button"
                  size="xs"
                  variant={selected ? 'secondary' : 'outline'}
                  aria-pressed={selected}
                  onClick={() => onPreviewVariantChange(option.value)}
                >
                  {option.label}
                </Button>
              )
            })}
          </div>
        </div>

        <AnchorEditor
          themeId={selectedTheme.id}
          variant={activeVariant}
          anchors={selectedTheme.anchors}
          tuning={tuning}
          onColorChange={(key, value) =>
            onAnchorColorChange(activeVariant, key, value)
          }
          onContrastChange={(value) =>
            onAnchorContrastChange(activeVariant, value)
          }
        />

        <WorkbenchSection title="Surfaces">
          {SURFACE_KEYS.map((key) => (
            <TuningSlider
              key={key}
              label={SURFACE_LABELS[key]}
              value={tuning.surfaceMix[key]}
              onChange={(value) =>
                onTuningChange((current) => ({
                  ...current,
                  surfaceMix: { ...current.surfaceMix, [key]: value },
                }))
              }
            />
          ))}
        </WorkbenchSection>

        <WorkbenchSection title="Raised & interaction">
          <TuningSlider
            label="Raised · light"
            value={tuning.raisedMix.light}
            onChange={(value) =>
              onTuningChange((current) => ({
                ...current,
                raisedMix: { ...current.raisedMix, light: value },
              }))
            }
          />
          <TuningSlider
            label="Raised · dark"
            value={tuning.raisedMix.dark}
            onChange={(value) =>
              onTuningChange((current) => ({
                ...current,
                raisedMix: { ...current.raisedMix, dark: value },
              }))
            }
          />
          <Separator />
          <TuningSlider
            label="Min accent Δ"
            value={tuning.minInteractionDelta.accent}
            min={0}
            max={0.2}
            step={0.005}
            suffix=""
            onChange={(value) =>
              onTuningChange((current) => ({
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
              onTuningChange((current) => ({
                ...current,
                minInteractionDelta: {
                  ...current.minInteractionDelta,
                  hover: value,
                },
              }))
            }
          />
        </WorkbenchSection>

        <p className="text-xs text-muted-foreground">
          Colors generate every surface; edits persist locally. Export contains
          every theme plus the global Prism tuning.
        </p>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t px-4 py-2.5">
        <Button type="button" size="sm" variant="outline" onClick={resetAll}>
          <RotateCcwIcon className="size-4" />
          Reset all
        </Button>
        <Button type="button" size="sm" onClick={() => setShowingExport(true)}>
          <DownloadIcon className="size-4" />
          Export JSON
        </Button>
      </div>
    </>
  )
}
