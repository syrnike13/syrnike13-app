import {
  APPEARANCE_GRADIENT_MAX_COLORS,
  APPEARANCE_GRADIENT_MIN_COLORS,
  type AppearanceGradientSettings,
} from '@syrnike13/platform'
import { useEffect, useState, type KeyboardEvent } from 'react'

import { PlusIcon, Trash2Icon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Slider } from '#/components/ui/slider'
import { themeGradientCss } from '#/features/appearance/theme-surfaces'
import { cn } from '#/lib/utils'

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

type GradientColorStopProps = {
  color: string
  index: number
  canRemove: boolean
  onChange: (color: string) => void
  onRemove: () => void
}

function GradientColorStop({
  color,
  index,
  canRemove,
  onChange,
  onRemove,
}: GradientColorStopProps) {
  const [draft, setDraft] = useState(color)

  useEffect(() => {
    setDraft(color)
  }, [color])

  function commitDraft() {
    const next = draft.trim()
    if (!HEX_COLOR_PATTERN.test(next)) {
      setDraft(color)
      return
    }
    onChange(next.toUpperCase())
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') event.currentTarget.blur()
    if (event.key === 'Escape') {
      setDraft(color)
      event.currentTarget.blur()
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/65 p-2">
      <label
        className="relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border shadow-sm"
        style={{ backgroundColor: color }}
        title={`Изменить цвет ${index + 1}`}
      >
        <span className="sr-only">Изменить цвет {index + 1}</span>
        <input
          type="color"
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          value={color}
          aria-label={`Цвет ${index + 1}`}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
      </label>
      <Input
        value={draft}
        aria-label={`HEX цвета ${index + 1}`}
        className="font-mono uppercase"
        maxLength={7}
        spellCheck={false}
        onBlur={commitDraft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0"
        disabled={!canRemove}
        aria-label={`Удалить цвет ${index + 1}`}
        title={canRemove ? 'Удалить цвет' : 'Нужен хотя бы один цвет'}
        onClick={onRemove}
      >
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  )
}

function randomHexColor(): string {
  const value = Math.floor(Math.random() * 0x1000000)
  return `#${value.toString(16).padStart(6, '0')}`.toUpperCase()
}

function randomGradient(): AppearanceGradientSettings {
  return {
    colors: [randomHexColor(), randomHexColor()],
    angle: Math.floor(Math.random() * 360),
    saturation: 74,
  }
}

type CustomThemeEditorProps = {
  gradient: AppearanceGradientSettings
  customized: boolean
  onPreview: (gradient: AppearanceGradientSettings) => void
  onChange: (gradient: AppearanceGradientSettings | null) => void
}

export function CustomThemeEditor({
  gradient,
  customized,
  onPreview,
  onChange,
}: CustomThemeEditorProps) {
  function updateColor(index: number, color: string) {
    const colors = [...gradient.colors]
    colors[index] = color
    onChange({ ...gradient, colors })
  }

  function removeColor(index: number) {
    if (gradient.colors.length <= APPEARANCE_GRADIENT_MIN_COLORS) return
    onChange({
      ...gradient,
      colors: gradient.colors.filter((_, colorIndex) => colorIndex !== index),
    })
  }

  function addColor() {
    if (gradient.colors.length >= APPEARANCE_GRADIENT_MAX_COLORS) return
    onChange({
      ...gradient,
      colors: [...gradient.colors, gradient.colors.at(-1)!],
    })
  }

  return (
    <div className="space-y-5">
      <div
        className="h-28 overflow-hidden rounded-xl border border-border/70 shadow-inner"
        style={{ backgroundImage: themeGradientCss(gradient) }}
        aria-label="Предпросмотр градиента"
        role="img"
      />

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label>Цвета</Label>
          <span className="text-xs text-muted-foreground">
            {gradient.colors.length}/{APPEARANCE_GRADIENT_MAX_COLORS}
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {gradient.colors.map((color, index) => (
            <GradientColorStop
              key={index}
              color={color}
              index={index}
              canRemove={
                gradient.colors.length > APPEARANCE_GRADIENT_MIN_COLORS
              }
              onChange={(nextColor) => updateColor(index, nextColor)}
              onRemove={() => removeColor(index)}
            />
          ))}
        </div>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={gradient.colors.length >= APPEARANCE_GRADIENT_MAX_COLORS}
          onClick={addColor}
        >
          <PlusIcon className="size-4" data-icon="inline-start" />
          Добавить цвет
        </Button>
      </div>

      <div className="space-y-5 rounded-xl border border-border/70 bg-card/55 p-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="theme-gradient-angle">Направление градиента</Label>
            <span className="text-sm tabular-nums text-muted-foreground">
              {gradient.angle}°
            </span>
          </div>
          <Slider
            id="theme-gradient-angle"
            min={0}
            max={360}
            step={1}
            value={[gradient.angle]}
            tooltipContent={(value) => `${value}°`}
            onValueChange={([angle]) => {
              if (angle == null) return
              onPreview({ ...gradient, angle })
            }}
            onValueCommit={([angle]) => {
              if (angle == null) return
              onChange({ ...gradient, angle })
            }}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="theme-gradient-saturation">Насыщенность цвета</Label>
            <span className="text-sm tabular-nums text-muted-foreground">
              {gradient.saturation}%
            </span>
          </div>
          <Slider
            id="theme-gradient-saturation"
            min={0}
            max={100}
            step={1}
            value={[gradient.saturation]}
            tooltipContent={(value) => `${value}%`}
            onValueChange={([saturation]) => {
              if (saturation == null) return
              onPreview({ ...gradient, saturation })
            }}
            onValueCommit={([saturation]) => {
              if (saturation == null) return
              onChange({ ...gradient, saturation })
            }}
          />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => onChange(randomGradient())}
        >
          Удивите меня
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!customized}
          className={cn(!customized && 'text-muted-foreground')}
          onClick={() => onChange(null)}
        >
          Сбросить к палитре
        </Button>
      </div>
    </div>
  )
}
