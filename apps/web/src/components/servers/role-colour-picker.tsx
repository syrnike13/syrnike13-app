import { useRef } from 'react'
import { CheckIcon, PencilIcon } from 'lucide-react'

import { Label } from '#/components/ui/label'
import { normalizeRoleColour } from '#/lib/server-permissions'
import { cn } from '#/lib/utils'

/** Палитра пресетов в духе Discord (18 цветов). */
export const ROLE_COLOUR_PRESETS = [
  '#1abc9c',
  '#2ecc71',
  '#3498db',
  '#9b59b6',
  '#e91e63',
  '#f1c40f',
  '#e67e22',
  '#e74c3c',
  '#95a5a6',
  '#607d8b',
  '#11806a',
  '#1f8b4c',
  '#206694',
  '#71368a',
  '#ad1457',
  '#c27c0e',
  '#a84300',
  '#992d22',
] as const

const DEFAULT_SWATCH = '#4e5058'

/** Квадрат высотой в два ряда пресетов (size-8 + gap-2 + size-8). */
const TWIN_ROW_SWATCH_CLASS = 'size-[calc(2*2rem+0.5rem)]'

const PRESET_SWATCH_CLASS = 'size-8'

function coloursMatch(a: string, b: string) {
  return normalizeRoleColour(a).toLowerCase() === normalizeRoleColour(b).toLowerCase()
}

type RoleColourPickerProps = {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}

export function RoleColourPicker({
  value,
  onChange,
  disabled,
  className,
}: RoleColourPickerProps) {
  const colourInputRef = useRef<HTMLInputElement>(null)
  const trimmed = value.trim()
  const hasColour = Boolean(trimmed)
  const matchingPreset = ROLE_COLOUR_PRESETS.find((preset) =>
    coloursMatch(preset, trimmed),
  )
  const isDefault = !hasColour
  const isCustom = hasColour && !matchingPreset
  const customDisplayColour = hasColour
    ? normalizeRoleColour(trimmed)
    : normalizeRoleColour('#5865f2')

  return (
    <div className={cn('space-y-3', className)}>
      <div className="space-y-1">
        <Label>Цвет</Label>
        <p className="text-sm text-muted-foreground">
          Цвет ника участника задаётся самой высокой ролью в списке ролей.
        </p>
      </div>

      <div className="flex items-start gap-2">
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={disabled}
            title="Без цвета"
            className={cn(
              'relative m-0 box-border shrink-0 appearance-none rounded-lg border-2 p-0',
              TWIN_ROW_SWATCH_CLASS,
              isDefault
                ? 'border-primary ring-2 ring-primary/30'
                : 'border-transparent',
              disabled && 'cursor-not-allowed opacity-50',
            )}
            style={{ backgroundColor: DEFAULT_SWATCH }}
            onClick={() => onChange('')}
          />

          <button
            type="button"
            disabled={disabled}
            title="Свой цвет"
            className={cn(
              'relative m-0 box-border shrink-0 appearance-none overflow-hidden rounded-lg border-2 p-0',
              TWIN_ROW_SWATCH_CLASS,
              isCustom
                ? 'border-primary ring-2 ring-primary/30'
                : 'border-transparent',
              disabled && 'cursor-not-allowed opacity-50',
            )}
            style={{ backgroundColor: customDisplayColour }}
            onClick={() => colourInputRef.current?.click()}
          >
            <span className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-sm bg-black/45 text-white">
              <PencilIcon className="size-3" />
            </span>
            <input
              ref={colourInputRef}
              type="color"
              className="sr-only"
              disabled={disabled}
              value={customDisplayColour}
              onChange={(event) => onChange(event.target.value)}
            />
          </button>
        </div>

        <div className="min-w-0 flex-1 overflow-x-auto pb-1">
          <div className="inline-grid grid-cols-9 gap-2">
            {ROLE_COLOUR_PRESETS.map((preset) => {
              const selected = matchingPreset === preset

              return (
                <button
                  key={preset}
                  type="button"
                  disabled={disabled}
                  title={preset}
                  className={cn(
                    'relative m-0 box-border shrink-0 appearance-none rounded-md border-2 p-0',
                    PRESET_SWATCH_CLASS,
                    selected
                      ? 'border-primary ring-2 ring-primary/30'
                      : 'border-transparent',
                    disabled && 'cursor-not-allowed opacity-50',
                  )}
                  style={{ backgroundColor: preset }}
                  onClick={() => onChange(preset)}
                >
                  {selected ? (
                    <CheckIcon
                      className="absolute inset-0 m-auto size-4 text-white drop-shadow-sm"
                      strokeWidth={3}
                      aria-hidden
                    />
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
