import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Input } from '@syrnike13/ui/primitives/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'
import { DropperIcon, XIcon } from '#/components/icons'
import { PresetSlider } from '#/components/ui/preset-slider'
import {
  hexToPickerHsv,
  normalizePickerHex,
  pickerHsvToHex,
  PICKER_HUE_SPECTRUM,
  type PickerHsv,
} from '#/features/appearance/theme-color-picker-model'
import type { CSSVars } from '#/lib/css-vars'

const HUE_STOPS = [{ value: 0 }, { value: 359 }]
const clamp = (value: number) => Math.max(0, Math.min(1, value))

/** Inline color-domain canvas; all surrounding controls are shared primitives. */
export function ThemeColorPicker({
  value,
  onChange,
  onRemove,
}: {
  value: string
  onChange: (color: string) => void
  /** Shown next to the eyedropper when the selected color can be removed. */
  onRemove?: () => void
}) {
  const t = useTranslations('settings.appearance.themeEditor.picker')
  const tEditor = useTranslations('settings.appearance.themeEditor')
  const [hsv, setHsv] = useState(() => hexToPickerHsv(value))
  const [hex, setHex] = useState(value.toUpperCase())
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nativeRef = useRef<HTMLInputElement>(null)
  const emittedRef = useRef(value.toUpperCase())
  const hintId = useId()
  const hueColor = pickerHsvToHex({
    hue: hsv.hue,
    saturation: 1,
    brightness: 1,
  })

  useEffect(() => {
    if (value.toUpperCase() === emittedRef.current) return
    emittedRef.current = value.toUpperCase()
    setHsv((previous) => hexToPickerHsv(value, previous.hue))
    setHex(value.toUpperCase())
  }, [value])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    // White/black are the HSV coordinate endpoints, not UI surface colors.
    const saturation = context.createLinearGradient(0, 0, canvas.width, 0)
    saturation.addColorStop(0, '#FFFFFF')
    saturation.addColorStop(1, hueColor)
    context.fillStyle = saturation
    context.fillRect(0, 0, canvas.width, canvas.height)
    const brightness = context.createLinearGradient(0, 0, 0, canvas.height)
    brightness.addColorStop(0, 'transparent')
    brightness.addColorStop(1, '#000000')
    context.fillStyle = brightness
    context.fillRect(0, 0, canvas.width, canvas.height)
  }, [hueColor])

  const update = (next: PickerHsv) => {
    const color = pickerHsvToHex(next)
    setHsv(next)
    setHex(color)
    emittedRef.current = color
    onChange(color)
  }

  const updateHex = (color: string) => {
    emittedRef.current = color
    setHex(color)
    setHsv((previous) => hexToPickerHsv(color, previous.hue))
    onChange(color)
  }

  const commitHex = () => {
    const normalized = normalizePickerHex(hex)
    if (normalized) updateHex(normalized)
    else setHex(value.toUpperCase())
  }

  // Native screen eyedropper where the engine has one, system palette otherwise.
  const pickFromScreen = async () => {
    const EyeDropper = (
      window as unknown as {
        EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> }
      }
    ).EyeDropper
    if (!EyeDropper) {
      nativeRef.current?.click()
      return
    }
    try {
      const { sRGBHex } = await new EyeDropper().open()
      const color = normalizePickerHex(sRGBHex)
      if (color) updateHex(color)
    } catch {
      // The person dismissed the eyedropper.
    }
  }

  const handlePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    update({
      ...hsv,
      saturation: clamp((event.clientX - bounds.left) / bounds.width),
      brightness: 1 - clamp((event.clientY - bounds.top) / bounds.height),
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const step = event.shiftKey ? 0.1 : 0.01
    const next = { ...hsv }
    switch (event.key) {
      case 'ArrowRight':
        next.saturation = clamp(hsv.saturation + step)
        break
      case 'ArrowLeft':
        next.saturation = clamp(hsv.saturation - step)
        break
      case 'ArrowUp':
        next.brightness = clamp(hsv.brightness + step)
        break
      case 'ArrowDown':
        next.brightness = clamp(hsv.brightness - step)
        break
      case 'Home':
        next.saturation = 0
        break
      case 'End':
        next.saturation = 1
        break
      default:
        return
    }
    event.preventDefault()
    update(next)
  }

  return (
    <div
      className="space-y-3"
      style={
        {
          '--slider-spectrum': PICKER_HUE_SPECTRUM,
          '--slider-hue': hueColor,
        } as CSSVars
      }
    >
      <div className="relative">
        {/* eslint-disable-next-line design/no-lookalike -- two-dimensional HSV color coordinates, not a replacement for a UI primitive */}
        <canvas
          ref={canvasRef}
          width={600}
          height={320}
          role="slider"
          tabIndex={0}
          aria-label={t('area')}
          aria-describedby={hintId}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsv.saturation * 100)}
          aria-valuetext={t('value', {
            saturation: Math.round(hsv.saturation * 100),
            brightness: Math.round(hsv.brightness * 100),
          })}
          className="h-36 w-full touch-none cursor-crosshair rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            handlePointer(event)
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              handlePointer(event)
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onKeyDown={handleKeyDown}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute left-(--picker-x) top-(--picker-y) size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-on-media ring-1 ring-media-backdrop/50"
          style={
            {
              '--picker-x': `${hsv.saturation * 100}%`,
              '--picker-y': `${(1 - hsv.brightness) * 100}%`,
            } as CSSVars
          }
        />
      </div>
      <span id={hintId} className="sr-only">
        {t('keyboardHint')}
      </span>
      <PresetSlider
        variant="hue"
        aria-label={t('hue')}
        mode="continuous"
        stops={HUE_STOPS}
        value={hsv.hue}
        step={1}
        showLabels={false}
        showMarks={false}
        formatValue={(hue) => `${Math.round(hue)}°`}
        onValueChange={(hue) => update({ ...hsv, hue })}
      />
      <InputGroup>
        <InputGroupAddon>
          <span
            aria-hidden
            className="size-6 rounded-sm border border-border bg-(--picker-color)"
            style={{ '--picker-color': value } as CSSVars}
          />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={t('hex')}
          value={hex}
          maxLength={7}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          onChange={(event) => {
            const next = event.target.value
            setHex(next)
            if (/^#?[\da-f]{6}$/i.test(next))
              updateHex(normalizePickerHex(next)!)
          }}
          onBlur={commitHex}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitHex()
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            aria-label={t('native')}
            title={t('native')}
            onClick={pickFromScreen}
          >
            <DropperIcon />
          </InputGroupButton>
          {onRemove ? (
            <InputGroupButton
              size="icon-sm"
              aria-label={tEditor('removeColor')}
              title={tEditor('removeColor')}
              onClick={onRemove}
            >
              <XIcon />
            </InputGroupButton>
          ) : null}
        </InputGroupAddon>
      </InputGroup>
      <Input
        ref={nativeRef}
        type="color"
        aria-label={t('nativeInput')}
        tabIndex={-1}
        className="hidden"
        value={value}
        onChange={(event) => updateHex(event.target.value.toUpperCase())}
      />
    </div>
  )
}
